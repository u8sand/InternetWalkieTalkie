// Minimal BIP-340 Schnorr signatures over secp256k1, needed only so public Nostr relays
// accept our (ephemeral, throwaway) signalling events. These keys protect nothing:
// all real authentication and encryption happens with the WebCrypto identity keys.

import { concat, sha256, utf8, hex, fromHex, randomBytes } from './encoding.js';

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };

function inv(a, m = P) {
  let [lo, hi, x0, x1] = [mod(a, m), m, 1n, 0n];
  while (lo > 1n) {
    const q = hi / lo;
    [lo, hi] = [hi - q * lo, lo];
    [x0, x1] = [x1 - q * x0, x0];
  }
  return mod(x0, m);
}

// Jacobian coordinates [X, Y, Z]; Z = 0 is the point at infinity.
function dbl([X, Y, Z]) {
  if (Z === 0n || Y === 0n) return [0n, 1n, 0n];
  const YY = mod(Y * Y), S = mod(4n * X * YY), M = mod(3n * X * X);
  const X3 = mod(M * M - 2n * S);
  return [X3, mod(M * (S - X3) - 8n * YY * YY), mod(2n * Y * Z)];
}

function add(p, q) {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q;
  const Z1Z1 = mod(Z1 * Z1), Z2Z2 = mod(Z2 * Z2);
  const U1 = mod(X1 * Z2Z2), U2 = mod(X2 * Z1Z1);
  const S1 = mod(Y1 * Z2 * Z2Z2), S2 = mod(Y2 * Z1 * Z1Z1);
  if (U1 === U2) return S1 === S2 ? dbl(p) : [0n, 1n, 0n];
  const H = mod(U2 - U1), R = mod(S2 - S1), HH = mod(H * H), HHH = mod(H * HH), V = mod(U1 * HH);
  const X3 = mod(R * R - HHH - 2n * V);
  return [X3, mod(R * (V - X3) - S1 * HHH), mod(H * Z1 * Z2)];
}

function mulG(k) {
  let r = [0n, 1n, 0n], d = [G[0], G[1], 1n];
  while (k > 0n) {
    if (k & 1n) r = add(r, d);
    d = dbl(d);
    k >>= 1n;
  }
  const zi = inv(r[2]), zi2 = mod(zi * zi);
  return [mod(r[0] * zi2), mod(r[1] * zi2 * zi)];
}

const toInt = (b) => BigInt('0x' + (hex(b) || '0'));
const toBytes = (n) => fromHex(n.toString(16).padStart(64, '0'));

async function taggedHash(tag, ...parts) {
  const t = await sha256(utf8(tag));
  return sha256(concat(t, t, ...parts));
}

export function randomSecret() {
  for (;;) {
    const d = toInt(randomBytes(32));
    if (d > 0n && d < N) return toBytes(d);
  }
}

export function publicKey(secret) {
  return toBytes(mulG(toInt(secret))[0]);
}

export async function signSchnorr(msg, secret, aux = randomBytes(32)) {
  const d0 = toInt(secret);
  if (d0 <= 0n || d0 >= N) throw new Error('invalid secret');
  const [px, py] = mulG(d0);
  const d = py & 1n ? N - d0 : d0;
  const pBytes = toBytes(px);
  const t = toInt(await taggedHash('BIP0340/aux', aux)) ^ d;
  const k0 = mod(toInt(await taggedHash('BIP0340/nonce', toBytes(t), pBytes, msg)), N);
  if (k0 === 0n) throw new Error('bad nonce');
  const [rx, ry] = mulG(k0);
  const k = ry & 1n ? N - k0 : k0;
  const rBytes = toBytes(rx);
  const e = mod(toInt(await taggedHash('BIP0340/challenge', rBytes, pBytes, msg)), N);
  return concat(rBytes, toBytes(mod(k + e * d, N)));
}

/** Build and sign a Nostr event (NIP-01). */
export async function nostrEvent(secret, pubHex, kind, tags, content) {
  const created_at = Math.floor(Date.now() / 1000);
  const id = await sha256(utf8(JSON.stringify([0, pubHex, created_at, kind, tags, content])));
  const sig = await signSchnorr(id, secret);
  return { id: hex(id), pubkey: pubHex, created_at, kind, tags, content, sig: hex(sig) };
}
