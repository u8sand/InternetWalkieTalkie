// End-to-end cryptography built only on WebCrypto (no third-party crypto code).
//
//  * Identity  = ECDSA P-256 signing key + ECDH P-256 key-agreement key.
//  * Fingerprint = SHA-256 over both public keys; it is the user's permanent ID.
//  * Ops (CRDT updates) are sealed for every conversation member:
//      random content key (CEK) -> AES-256-GCM over the body (header bound as AAD)
//      one ephemeral ECDH key per op -> HKDF per recipient -> AES-GCM-wrapped CEK
//      whole envelope signed with the author's ECDSA key.
//  * Signals (WebRTC offers etc. sent through public relays) use ECIES to the
//    recipient's ECDH key with the sender's signature inside the ciphertext.
//  * Backups are encrypted with PBKDF2-SHA256 (600k iterations) + AES-GCM.

import { utf8, fromUtf8, b64u, fromB64u, hex, concat, randomBytes, canonical, sha256 } from './encoding.js';

const subtle = globalThis.crypto.subtle;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' };

export const OP_VERSION = 1;

// ---------------------------------------------------------------- identity

export async function fingerprint(signRaw, dhRaw) {
  const h = await sha256(concat(utf8('iwt-fp-v1'), signRaw, dhRaw));
  return hex(h).slice(0, 40);
}

async function buildIdentity(name, signPriv, signPub, dhPriv, dhPub) {
  const signRaw = new Uint8Array(await subtle.exportKey('raw', signPub));
  const dhRaw = new Uint8Array(await subtle.exportKey('raw', dhPub));
  const fp = await fingerprint(signRaw, dhRaw);
  const id = { name, fp, signPriv, signPub, dhPriv, dhPub, signRaw, dhRaw };
  id.card = () => ({ v: 1, n: id.name, s: b64u(signRaw), d: b64u(dhRaw) });
  return id;
}

export async function generateIdentity(name) {
  const s = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const d = await subtle.generateKey(ECDH, true, ['deriveBits']);
  return buildIdentity(name, s.privateKey, s.publicKey, d.privateKey, d.publicKey);
}

export async function exportIdentity(id) {
  return {
    v: 1,
    name: id.name,
    sign: await subtle.exportKey('jwk', id.signPriv),
    dh: await subtle.exportKey('jwk', id.dhPriv),
  };
}

export async function importIdentity(stored) {
  if (!stored || stored.v !== 1) throw new Error('unsupported identity format');
  const pubJwk = ({ kty, crv, x, y }) => ({ kty, crv, x, y, ext: true });
  const signPriv = await subtle.importKey('jwk', stored.sign, ECDSA, true, ['sign']);
  const signPub = await subtle.importKey('jwk', pubJwk(stored.sign), ECDSA, true, ['verify']);
  const dhPriv = await subtle.importKey('jwk', stored.dh, ECDH, true, ['deriveBits']);
  const dhPub = await subtle.importKey('jwk', pubJwk(stored.dh), ECDH, true, []);
  return buildIdentity(stored.name, signPriv, signPub, dhPriv, dhPub);
}

/**
 * Parse and validate a public contact card {v,n,s,d}. Returns the peer's key bundle.
 * The fingerprint is always recomputed from the keys, never trusted from input.
 */
export async function importCard(card) {
  if (!card || card.v !== 1 || typeof card.s !== 'string' || typeof card.d !== 'string') {
    throw new Error('invalid contact card');
  }
  const signRaw = fromB64u(card.s);
  const dhRaw = fromB64u(card.d);
  if (signRaw.length !== 65 || dhRaw.length !== 65) throw new Error('invalid key length');
  const signKey = await subtle.importKey('raw', signRaw, ECDSA, true, ['verify']);
  const dhKey = await subtle.importKey('raw', dhRaw, ECDH, true, []);
  const name = typeof card.n === 'string' ? card.n.slice(0, 64) : '';
  const fp = await fingerprint(signRaw, dhRaw);
  return { fp, name, signKey, dhKey, card: { v: 1, n: name, s: card.s, d: card.d } };
}

export async function sign(id, bytes) {
  return new Uint8Array(await subtle.sign(SIGN_ALG, id.signPriv, bytes));
}

export async function verify(signKey, sig, bytes) {
  try {
    return await subtle.verify(SIGN_ALG, signKey, sig, bytes);
  } catch {
    return false;
  }
}

/** Short human-comparable code for verifying two parties out of band. */
export async function safetyNumber(fpA, fpB) {
  const [a, b] = [fpA, fpB].sort();
  const h = await sha256(utf8('iwt-safety-v1|' + a + '|' + b));
  const groups = [];
  for (let i = 0; i < 6; i++) {
    const n = ((h[i * 3] << 16) | (h[i * 3 + 1] << 8) | h[i * 3 + 2]) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups.join(' ');
}

// ---------------------------------------------------------------- primitives

async function hkdfKey(secret, salt, info, usage) {
  const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

async function ecdh(priv, pub) {
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

async function aesEncrypt(key, plaintext, aad) {
  const iv = randomBytes(12);
  const params = { name: 'AES-GCM', iv };
  if (aad) params.additionalData = aad;
  const ct = new Uint8Array(await subtle.encrypt(params, key, plaintext));
  return concat(iv, ct);
}

async function aesDecrypt(key, blob, aad) {
  const params = { name: 'AES-GCM', iv: blob.subarray(0, 12) };
  if (aad) params.additionalData = aad;
  return new Uint8Array(await subtle.decrypt(params, key, blob.subarray(12)));
}

// ---------------------------------------------------------------- ops (CRDT updates)

const HEADER_FIELDS = ['v', 'conv', 'author', 'seq', 'lamport'];

export function opHeader(env) {
  const h = {};
  for (const f of HEADER_FIELDS) h[f] = env[f];
  return h;
}

function unsignedEnvelope(env) {
  const { sig, ...rest } = env;
  return rest;
}

/**
 * Encrypt and sign an op body for a set of recipients.
 * @param id         author identity
 * @param recipients [{fp, dhKey}] — must include the author so their other copies stay readable
 * @param header     {conv, seq, lamport}
 * @param body       JSON-serialisable plaintext
 */
export async function sealOp(id, recipients, header, body) {
  const h = { v: OP_VERSION, conv: header.conv, author: id.fp, seq: header.seq, lamport: header.lamport };
  const aad = utf8(canonical(h));
  const cekRaw = randomBytes(32);
  const cek = await subtle.importKey('raw', cekRaw, 'AES-GCM', false, ['encrypt']);
  const ct = await aesEncrypt(cek, utf8(JSON.stringify(body)), aad);

  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const keys = {};
  for (const r of recipients) {
    const kek = await hkdfKey(await ecdh(eph.privateKey, r.dhKey), ephRaw, 'iwt-wrap-v1|' + r.fp, ['encrypt']);
    keys[r.fp] = b64u(await aesEncrypt(kek, cekRaw, aad));
  }
  const env = { ...h, eph: b64u(ephRaw), ct: b64u(ct), keys };
  env.sig = b64u(await sign(id, utf8(canonical(env))));
  return env;
}

export function isWellFormedOp(env) {
  return !!env && typeof env === 'object'
    && env.v === OP_VERSION
    && typeof env.conv === 'string' && env.conv.length <= 80
    && typeof env.author === 'string' && /^[0-9a-f]{40}$/.test(env.author)
    && Number.isSafeInteger(env.seq) && env.seq > 0
    && Number.isSafeInteger(env.lamport) && env.lamport > 0
    && typeof env.eph === 'string' && typeof env.ct === 'string' && typeof env.sig === 'string'
    && env.keys && typeof env.keys === 'object' && !Array.isArray(env.keys);
}

export async function verifyOp(env, signKey) {
  try {
    return await verify(signKey, fromB64u(env.sig), utf8(canonical(unsignedEnvelope(env))));
  } catch {
    return false;
  }
}

/** Decrypt an op addressed to `id`. Throws if not addressed to us or tampered with. */
export async function openOp(id, env) {
  const wrapped = env.keys[id.fp];
  if (typeof wrapped !== 'string') throw new Error('op not addressed to us');
  const aad = utf8(canonical(opHeader(env)));
  const ephRaw = fromB64u(env.eph);
  const ephKey = await subtle.importKey('raw', ephRaw, ECDH, false, []);
  const kek = await hkdfKey(await ecdh(id.dhPriv, ephKey), ephRaw, 'iwt-wrap-v1|' + id.fp, ['decrypt']);
  const cekRaw = await aesDecrypt(kek, fromB64u(wrapped), aad);
  const cek = await subtle.importKey('raw', cekRaw, 'AES-GCM', false, ['decrypt']);
  return JSON.parse(fromUtf8(await aesDecrypt(cek, fromB64u(env.ct), aad)));
}

// ---------------------------------------------------------------- signals (via relays)

/**
 * Encrypt a signalling payload to one recipient. The sender's card and signature are inside
 * the ciphertext, so relays learn neither who is talking nor what is said.
 */
export async function sealSignal(id, recipient, payload) {
  const inner = { ...payload, from: id.card(), to: recipient.fp, ts: Date.now(), nonce: b64u(randomBytes(12)) };
  const sig = await sign(id, utf8(canonical(inner)));
  const plaintext = utf8(JSON.stringify({ m: inner, sig: b64u(sig) }));
  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const key = await hkdfKey(await ecdh(eph.privateKey, recipient.dhKey), ephRaw, 'iwt-signal-v1|' + recipient.fp, ['encrypt']);
  return b64u(concat(ephRaw, await aesEncrypt(key, plaintext, ephRaw)));
}

/** Returns {payload, sender} or throws. Caller must still check freshness/replay. */
export async function openSignal(id, blob) {
  const bytes = fromB64u(blob);
  if (bytes.length < 65 + 12 + 16) throw new Error('short signal');
  const ephRaw = bytes.subarray(0, 65);
  const ephKey = await subtle.importKey('raw', ephRaw, ECDH, false, []);
  const key = await hkdfKey(await ecdh(id.dhPriv, ephKey), ephRaw, 'iwt-signal-v1|' + id.fp, ['decrypt']);
  const { m, sig } = JSON.parse(fromUtf8(await aesDecrypt(key, bytes.subarray(65), ephRaw)));
  if (!m || m.to !== id.fp) throw new Error('signal not for us');
  const sender = await importCard(m.from);
  if (!(await verify(sender.signKey, fromB64u(sig), utf8(canonical(m))))) throw new Error('bad signal signature');
  return { payload: m, sender };
}

// ---------------------------------------------------------------- channel authentication

export function authTranscript(nonce, signerDtls, verifierDtls) {
  return utf8('iwt-auth-v1|' + nonce + '|' + signerDtls + '|' + verifierDtls);
}

// ---------------------------------------------------------------- backups

const PBKDF2_ITERATIONS = 600000;

export async function encryptBackup(obj, passphrase) {
  const salt = randomBytes(16);
  const base = await subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const ct = await aesEncrypt(key, utf8(JSON.stringify(obj)), utf8('iwt-backup-v1'));
  return { format: 'iwt-backup', v: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: b64u(salt), data: b64u(ct) };
}

export async function decryptBackup(file, passphrase) {
  if (!file || file.format !== 'iwt-backup' || file.v !== 1) throw new Error('not a backup file');
  const base = await subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64u(file.salt), iterations: file.iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  try {
    return JSON.parse(fromUtf8(await aesDecrypt(key, fromB64u(file.data), utf8('iwt-backup-v1'))));
  } catch {
    throw new Error('wrong passphrase or corrupted backup');
  }
}
