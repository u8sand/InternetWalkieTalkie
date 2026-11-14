// Device linking: copy your identity and history to another device (e.g. laptop → phone).
//
//  1. The existing device ("host") makes a one-time secret S and shows it as a QR code /
//     link:  …#link=<code>. The code also carries the relay and STUN lists to use.
//  2. The new device ("joiner") opens it. Both derive from S:
//       topic  = H("iwt-link-v1|" S)        — a relay rendezvous nobody else can find
//       kSig   = HKDF(S, "iwt-link-signal") — encrypts the WebRTC offer/answer on the relay
//       kMac   = HKDF(S, "iwt-link-mac")    — proves knowledge of S, bound to DTLS fingerprints
//       kData  = HKDF(S, "iwt-link-data")   — encrypts the transferred state (defence in depth)
//  3. Over the DataChannel each side sends HMAC(kMac, role | own DTLS fp | peer DTLS fp); a
//     man in the middle can't produce it without S, and couldn't relay the channel anyway.
//  4. The host streams its full state (identity keys, contacts, conversations, ops,
//     settings) in encrypted chunks. The joiner imports it under a NEW device id, so the
//     two devices are separate CRDT writers that then keep each other in sync.
//
// The secret is single-use and expires after LINK_TTL_MS. Anyone who sees the QR code in
// that window could clone the identity, so the UI says so.

import { RelayPool } from './signaling.js';
import { dtlsFingerprint } from './peer.js';
import { b64u, fromB64u, utf8, fromUtf8, hex, sha256, randomBytes, concat, pack, unpack, equalBytes } from './encoding.js';

const subtle = globalThis.crypto.subtle;
export const LINK_TTL_MS = 5 * 60000;
const CHUNK = 32 * 1024;

async function deriveKeys(S) {
  const base = await subtle.importKey('raw', S, 'HKDF', false, ['deriveKey']);
  const aes = (info) => subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return {
    topic: hex(await sha256(concat(utf8('iwt-link-v1|'), S))).slice(0, 32),
    sig: await aes('iwt-link-signal'),
    data: await aes('iwt-link-data'),
    mac: await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('iwt-link-mac') }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
  };
}

async function seal(key, obj) {
  const iv = randomBytes(12);
  return b64u(concat(iv, new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(JSON.stringify(obj))))));
}

async function open(key, blob) {
  const b = fromB64u(blob);
  return JSON.parse(fromUtf8(new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12)))));
}

/** Both DTLS fingerprints, or throws if either SDP doesn't commit to exactly one. */
function fingerprints(pc) {
  const local = dtlsFingerprint(pc.localDescription?.sdp);
  const remote = dtlsFingerprint(pc.remoteDescription?.sdp);
  if (!local || !remote) throw new Error('ambiguous DTLS fingerprint');
  return { local, remote };
}

async function proof(keys, role, pc) {
  const { local, remote } = fingerprints(pc);
  return new Uint8Array(await subtle.sign('HMAC', keys.mac, utf8('iwt-link-proof|' + role + '|' + local + '|' + remote)));
}

async function expectedProof(keys, role, pc) {
  // What the other side computes: its own DTLS fp is our remote one.
  const { local, remote } = fingerprints(pc);
  return new Uint8Array(await subtle.sign('HMAC', keys.mac, utf8('iwt-link-proof|' + role + '|' + remote + '|' + local)));
}

function waitIce(pc, ms = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } });
  });
}

/** Which kinds of network address an SDP offers: host (local network), srflx (public, via STUN), relay (TURN). */
function candidateKinds(sdp) {
  const kinds = new Set();
  for (const m of String(sdp || '').matchAll(/^a=candidate:.* typ (\w+)/gm)) kinds.add(m[1]);
  return kinds;
}

/** The public (STUN-discovered) addresses an SDP offers. */
function publicIps(sdp) {
  const ips = new Set();
  for (const m of String(sdp || '').matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ srflx/gm)) ips.add(m[1]);
  return ips;
}

/**
 * Why two devices found each other on the relay but couldn't open a direct connection, and
 * what to do about it. The transfer never goes through a relay, so it needs a network path.
 */
function connectHelp(pc) {
  const mine = candidateKinds(pc.localDescription?.sdp), theirs = candidateKinds(pc.remoteDescription?.sdp);
  const show = (k) => (k.has('relay') ? 'TURN relay' : k.has('srflx') ? 'public address' : k.has('host') ? 'local network only' : 'no address');
  let why;
  if (mine.has('relay') || theirs.has('relay')) why = 'Even the TURN server could not carry the connection; check its address and credentials in Settings.';
  else if (!mine.has('srflx') || !theirs.has('srflx')) why = 'At least one device could not find its public address, so they can only meet on the same local network. Put both on the same Wi-Fi (not a guest network), or check the STUN servers in Settings.';
  else if ([...publicIps(pc.localDescription?.sdp)].some((ip) => publicIps(pc.remoteDescription?.sdp).has(ip))) {
    // Same public address = same router, yet they couldn't reach each other inside the network.
    why = 'Both devices are on the same network but could not find each other on it. Browsers hide local addresses behind names that some firewalls, VPNs and routers don\'t pass along. Turn off any VPN, and allow this site to use the camera on both devices (for example by using "Scan QR" here once): with that permission the browser shares the real local address. Then try again.';
  } else why = 'The networks between them block direct connections. This is common on mobile data and on guest or office Wi-Fi. Put both devices on the same home Wi-Fi and try again, or add a TURN server in Settings.';
  return `${why} You can also move your identity with an encrypted backup file (Settings → Backup), which needs no connection. [this device: ${show(mine)}; other device: ${show(theirs)}]`;
}

function parseCode(text) {
  text = String(text).trim();
  const m = /#link=([A-Za-z0-9_-]+)/.exec(text);
  return m ? m[1] : text;
}

class LinkBase extends EventTarget {
  constructor() {
    super();
    this.pool = null;
    this.pc = null;
    this.closed = false;
  }

  _status(state, extra = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, ...extra } }));
  }

  _fail(message) {
    if (this.closed) return;
    this._status('failed', { message });
    this.close();
  }

  close() {
    this.closed = true;
    clearTimeout(this.expiry);
    clearInterval(this.retry);
    try { this.pool?.close(); } catch {}
    try { this.pc?.close(); } catch {}
  }

  _send(obj) { this.dc.send(JSON.stringify(obj)); }

  async _drain() {
    if (this.dc.bufferedAmount < 1024 * 1024) return;
    await new Promise((r) => this.dc.addEventListener('bufferedamountlow', r, { once: true }));
  }
}

/** Existing device: offers its identity to whoever opens the code. */
export class LinkHost extends LinkBase {
  static async start(engine) {
    const h = new LinkHost();
    h.engine = engine;
    h.S = randomBytes(16);
    h.keys = await deriveKeys(h.S);
    const relays = engine.settings.relays || [];
    if (!relays.length) throw new Error('Linking needs at least one signalling relay (Settings). You can use an encrypted backup file instead.');
    h.code = await pack({ t: 'iwt-link', s: b64u(h.S), r: relays, i: engine.settings.iceServers || [] });
    h.pool = new RelayPool();
    h.pool.setUrls(relays);
    h.pool.setTopics([h.keys.topic], []);
    h.pool.addEventListener('event', (e) => h._onSignal(e.detail));
    h.expiry = setTimeout(() => h._fail('The link code expired. Start again.'), LINK_TTL_MS);
    h._status('waiting');
    return h;
  }

  async _onSignal(ev) {
    if (this.pc || this.closed) return; // single use
    let msg;
    try { msg = await open(this.keys.sig, ev.content); } catch { return; }
    if (msg.type !== 'offer' || typeof msg.sdp !== 'string') return;
    this._status('connecting');
    const pc = this.pc = new RTCPeerConnection({ iceServers: (this.engine.settings.iceServers || []).map((u) => ({ urls: u })) });
    pc.ondatachannel = (e) => this._onChannel(e.channel);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') this._fail('Could not connect to the new device. ' + connectHelp(pc)); };
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce(pc);
    const answer = await seal(this.keys.sig, { type: 'answer', sdp: pc.localDescription.sdp, nonce: msg.nonce });
    for (let i = 0; i < 3 && !this.closed; i++) {
      await this.pool.publish(this.keys.topic, answer);
      await new Promise((r) => setTimeout(r, 1500));
      if (this.dc?.readyState === 'open') break;
    }
  }

  _onChannel(dc) {
    this.dc = dc;
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'proof') {
        let ok = false;
        try { ok = equalBytes(fromB64u(msg.mac), await expectedProof(this.keys, 'join', this.pc)); } catch {}
        if (!ok) return this._fail('The other device could not prove it holds the link code.');
        this._send({ t: 'proof', mac: b64u(await proof(this.keys, 'host', this.pc)) });
        await this._sendState();
      } else if (msg.t === 'done') {
        this._status('done');
        setTimeout(() => this.close(), 500);
      }
    };
  }

  async _sendState() {
    this._status('sending');
    const state = await this.engine.exportState();
    const blob = fromB64u(await seal(this.keys.data, state));
    const total = Math.ceil(blob.length / CHUNK);
    this._send({ t: 'begin', chunks: total, bytes: blob.length });
    for (let i = 0; i < total; i++) {
      await this._drain();
      this._send({ t: 'chunk', i, data: b64u(blob.subarray(i * CHUNK, (i + 1) * CHUNK)) });
      this._status('sending', { progress: (i + 1) / total, bytes: blob.length });
    }
    this._send({ t: 'end' });
  }
}

/** New device: fetches the identity and history from the host. Resolves with the state. */
export class LinkJoin extends LinkBase {
  static async start(codeOrLink) {
    let info;
    try { info = await unpack(parseCode(codeOrLink)); } catch { throw new Error("That isn't a device link code."); }
    if (info?.t !== 'iwt-link' || typeof info.s !== 'string') throw new Error("That isn't a device link code.");
    const j = new LinkJoin();
    j.S = fromB64u(info.s);
    j.keys = await deriveKeys(j.S);
    j.result = new Promise((resolve, reject) => { j._resolve = resolve; j._reject = reject; });
    j.addEventListener('status', (e) => { if (e.detail.state === 'failed') j._reject(new Error(e.detail.message)); });
    j.pool = new RelayPool();
    j.pool.setUrls(Array.isArray(info.r) ? info.r : []);
    j.pool.setTopics([j.keys.topic], []);
    j.pool.addEventListener('event', (e) => j._onSignal(e.detail));
    j.expiry = setTimeout(() => j._fail('Timed out. Make sure the other device is still showing the code.'), LINK_TTL_MS);

    const pc = j.pc = new RTCPeerConnection({ iceServers: (Array.isArray(info.i) ? info.i : []).map((u) => ({ urls: u })) });
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') j._fail('Could not connect to the other device. ' + connectHelp(pc)); };
    j._onChannel(pc.createDataChannel('iwt-link', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(pc);
    j.nonce = b64u(randomBytes(9));
    const offer = await seal(j.keys.sig, { type: 'offer', sdp: pc.localDescription.sdp, nonce: j.nonce });
    j._status('connecting');
    // The host may still be connecting to its relays: repeat until it answers.
    const publish = () => { if (!j.answered) j.pool.publish(j.keys.topic, offer); };
    j.pool.addEventListener('relayopen', publish);
    j.retry = setInterval(publish, 4000);
    return j;
  }

  async _onSignal(ev) {
    if (this.answered || this.closed) return;
    let msg;
    try { msg = await open(this.keys.sig, ev.content); } catch { return; }
    if (msg.type !== 'answer' || msg.nonce !== this.nonce || typeof msg.sdp !== 'string') return;
    this.answered = true;
    clearInterval(this.retry);
    await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
  }

  _onChannel(dc) {
    this.dc = dc;
    const parts = [];
    let expected = 0, size = 0, verified = false;
    dc.onopen = async () => {
      try { this._send({ t: 'proof', mac: b64u(await proof(this.keys, 'join', this.pc)) }); }
      catch { this._fail('Could not verify the connection to the other device.'); }
    };
    dc.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'proof') {
        try { verified = equalBytes(fromB64u(msg.mac), await expectedProof(this.keys, 'host', this.pc)); } catch { verified = false; }
        if (!verified) return this._fail('The other device could not prove it created this code.');
        this._status('receiving', { progress: 0 });
      } else if (!verified) {
        return;
      } else if (msg.t === 'begin') {
        expected = msg.chunks; size = msg.bytes;
      } else if (msg.t === 'chunk') {
        parts[msg.i] = fromB64u(msg.data);
        this._status('receiving', { progress: parts.filter(Boolean).length / expected, bytes: size });
      } else if (msg.t === 'end') {
        try {
          if (parts.filter(Boolean).length !== expected) throw new Error('incomplete transfer');
          const state = await open(this.keys.data, b64u(concat(...parts)));
          this._send({ t: 'done' });
          this._status('done');
          this._resolve(state);
          setTimeout(() => this.close(), 1000);
        } catch (err) { this._fail('The transfer was corrupted: ' + err.message); }
      }
    };
  }
}
