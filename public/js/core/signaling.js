// Rendezvous over public Nostr relays.
//
// Relays are only used to exchange WebRTC connection offers between two peers
// who are online at the same time. Every payload is end-to-end encrypted
// (crypto.sealSignal) and published as an *ephemeral* event kind, which relays
// forward to live subscribers but do not store. Each session uses a fresh
// throwaway Nostr key, so relays cannot link sessions to an identity.
// Any relay can be swapped out in Settings; the app works with none at all via
// manual (copy/paste or QR) connection codes.

import { randomSecret, publicKey, nostrEvent } from './schnorr.js';
import { hex, sha256, utf8, b64u, randomBytes } from './encoding.js';

export const SIGNAL_KIND = 25050; // 20000–29999 = ephemeral (NIP-16)

export const utcDay = (t = Date.now()) => Math.floor(t / 86400000);

/** Inbox topic for a fingerprint on a given UTC day (computable by anyone holding the card). */
export async function inboxTopic(fp, day = utcDay()) {
  return hex(await sha256(utf8('iwt-inbox-v1|' + fp + '|' + day))).slice(0, 32);
}

class Relay {
  constructor(pool, url) {
    this.pool = pool;
    this.url = url;
    this.ws = null;
    this.backoff = 1000;
    this.closed = false;
    this.timer = null;
    this.connect();
  }

  get open() { return this.ws?.readyState === 1; }

  connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch { return this.retry(); }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.subscribe();
      this.pool._status();
      this.pool.dispatchEvent(new CustomEvent('relayopen', { detail: this.url }));
    };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT' && msg[1] === this.pool.subId && msg[2]) this.pool._onEvent(msg[2]);
    };
    ws.onclose = () => { this.pool._status(); this.retry(); };
    ws.onerror = () => {};
  }

  retry() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60000);
  }

  subscribe() {
    if (!this.open || !this.pool.topics.length) return;
    this.ws.send(JSON.stringify(['REQ', this.pool.subId, {
      kinds: [SIGNAL_KIND], '#t': this.pool.topics, since: Math.floor(Date.now() / 1000) - 60,
    }]));
  }

  send(msg) {
    if (this.open) this.ws.send(msg);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch {}
  }
}

export class RelayPool extends EventTarget {
  constructor() {
    super();
    this.secret = randomSecret();
    this.pub = hex(publicKey(this.secret));
    this.subId = 'iwt-' + b64u(randomBytes(6));
    this.relays = new Map();
    this.topics = [];
    this.seen = new Set();
  }

  setUrls(urls) {
    const want = new Set(urls.filter((u) => /^wss?:\/\//.test(u)));
    for (const [u, r] of this.relays) if (!want.has(u)) { r.close(); this.relays.delete(u); }
    for (const u of want) if (!this.relays.has(u)) this.relays.set(u, new Relay(this, u));
    this._status();
  }

  setTopics(topics) {
    const t = [...new Set(topics)].sort();
    if (t.join() === this.topics.join()) return;
    this.topics = t;
    for (const r of this.relays.values()) r.subscribe();
  }

  async publish(topic, content) {
    const ev = await nostrEvent(this.secret, this.pub, SIGNAL_KIND, [['t', topic]], content);
    this.seen.add(ev.id);
    const msg = JSON.stringify(['EVENT', ev]);
    let sent = 0;
    for (const r of this.relays.values()) if (r.open) { r.send(msg); sent++; }
    return sent;
  }

  status() {
    let connected = 0;
    for (const r of this.relays.values()) if (r.open) connected++;
    return { connected, total: this.relays.size };
  }

  _status() {
    this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
  }

  _onEvent(ev) {
    if (!ev || typeof ev.id !== 'string' || typeof ev.content !== 'string' || ev.kind !== SIGNAL_KIND) return;
    if (this.seen.has(ev.id)) return; // same event via several relays, or our own echo
    this.seen.add(ev.id);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
    this.dispatchEvent(new CustomEvent('event', { detail: ev }));
  }

  close() {
    for (const r of this.relays.values()) r.close();
    this.relays.clear();
  }
}
