// The sync protocol carried by signalling relays, for two endpoints that can't open a direct
// WebRTC connection (strict NATs, firewalls, or direct connections switched off).
//
// Each protocol message is JSON, cut into parts small enough for any relay, and every part
// travels as a sealed signal: encrypted to the recipient and signed by the sender, like the
// connection offers relays already carry. So a relay learns nothing new about content — only
// that more, and larger, events pass between two topics. There is no handshake: each part
// authenticates itself, and the protocol is a CRDT sync, so loss, duplication and reordering
// are harmless (the periodic re-sync repairs anything missed).
//
// Attachments are never sent this way; they wait for a direct connection.

import { Session } from './peer.js';
import { b64u, randomBytes } from './encoding.js';

const PART_CHARS = 24 * 1024;   // per event, before sealing (≈33 KB on the wire)
const PACE_MS = 200;            // gap between events, to stay within relays' rate limits
const MAX_QUEUE = 400;          // parts waiting to go out; beyond this, sends are refused (sync retries)
const MAX_MESSAGE_PARTS = 64;   // largest message accepted (≈1.5 MB)
const MAX_PARTIAL = 16;         // messages being reassembled at once
const RESYNC_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RelaySession extends Session {
  /**
   * @param remote  key bundle of the other identity (from the keyring)
   * @param dev     their device id
   * @param sendSignal async (payload) => void: seals and publishes one signal to them
   */
  constructor(engine, { remote, dev, sendSignal }) {
    super(engine);
    this.direct = false;
    this.route = 'relay';
    this.remote = remote;
    this.dev = dev;
    this.authed = true;
    this.state = 'ready';
    this.createdAt = Date.now();
    this.lastSeen = Date.now();
    this.sendSignal = sendSignal;
    this.queue = [];
    this.partial = new Map(); // message id -> {parts: [], have, at}
    this.resync = setInterval(() => this.sendSync(), RESYNC_MS);
  }

  _send(obj) {
    if (this.state === 'closed') return false;
    const s = JSON.stringify(obj);
    const n = Math.ceil(s.length / PART_CHARS);
    if (n > MAX_MESSAGE_PARTS || this.queue.length + n > MAX_QUEUE) return false;
    const id = b64u(randomBytes(6));
    for (let i = 0; i < n; i++) this.queue.push({ id, i, n, d: s.slice(i * PART_CHARS, (i + 1) * PART_CHARS) });
    this._pump();
    return true;
  }

  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this.queue.length && this.state !== 'closed') {
        await this.sendSignal(this.queue.shift());
        await sleep(PACE_MS);
      }
    } finally { this._pumping = false; }
  }

  /** Backpressure for large syncs. */
  async _drain() {
    while (this.queue.length > 40 && this.state !== 'closed') await sleep(PACE_MS);
  }

  /** One part arrived (already decrypted and its signature checked by the caller). */
  receive(p) {
    this.lastSeen = Date.now();
    if (!p || typeof p.id !== 'string' || p.id.length > 16 || typeof p.d !== 'string' || p.d.length > PART_CHARS) return;
    if (!Number.isSafeInteger(p.i) || !Number.isSafeInteger(p.n) || p.n < 1 || p.n > MAX_MESSAGE_PARTS || p.i < 0 || p.i >= p.n) return;
    let text = p.d;
    if (p.n > 1) {
      let m = this.partial.get(p.id);
      if (!m) {
        for (const [k, v] of this.partial) if (Date.now() - v.at > 120000) this.partial.delete(k);
        if (this.partial.size >= MAX_PARTIAL) this.partial.delete(this.partial.keys().next().value);
        m = { parts: new Array(p.n), have: 0, at: Date.now() };
        this.partial.set(p.id, m);
      }
      if (m.parts.length !== p.n || m.parts[p.i] !== undefined) return;
      m.parts[p.i] = p.d; m.have++;
      if (m.have < p.n) return;
      this.partial.delete(p.id);
      text = m.parts.join('');
    }
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    // Strictly in order, as on a DataChannel.
    this._rx = this._rx.then(() => this._handle(msg)).catch((err) => console.warn('relay message error', err));
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearInterval(this.resync);
    this.queue.length = 0;
    this.dispatchEvent(new CustomEvent('close', { detail: this }));
  }
}
