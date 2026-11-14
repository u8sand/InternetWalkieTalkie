// Rendezvous over public Nostr relays, plus optional user-owned mailbox relays.
//
// Relays are only used to exchange WebRTC connection offers between two peers
// who are online at the same time. Every payload is end-to-end encrypted
// (crypto.sealSignal) and published as an *ephemeral* event kind, which relays
// forward to live subscribers but do not store. Each session uses a fresh
// throwaway Nostr key, so relays cannot link sessions to an identity.
// Any relay can be swapped out in Settings; the app works with none at all via
// manual (copy/paste or QR) connection codes.
//
// Mailbox relays are different: a user lists relays they run or trust, and only
// those ever receive *stored* events (MAIL_KIND, NIP-40 expiry). Contacts post
// encrypted updates there while the owner is offline. Public signalling relays
// are never sent a stored event and are never asked for one.

import { randomSecret, publicKey, nostrEvent } from './schnorr.js';
import { hex, b64u, randomBytes } from './encoding.js';

export const SIGNAL_KIND = 25050; // 20000–29999 = ephemeral (NIP-16): forwarded, never stored
export const MAIL_KIND = 4050;    // 1000–9999 = regular (stored) — only ever sent to mailbox relays
export const MAIL_TTL_S = 7 * 86400;

// Relays may cap how many values one filter holds, so long topic lists are split up.
const TOPICS_PER_FILTER = 400;
const chunks = (list) => Array.from({ length: Math.ceil(list.length / TOPICS_PER_FILTER) }, (_, i) => list.slice(i * TOPICS_PER_FILTER, (i + 1) * TOPICS_PER_FILTER));
const tTags = (topics) => [].concat(topics).map((t) => ['t', t]);

class Relay {
  constructor(pool, url, mailbox) {
    this.pool = pool;
    this.url = url;
    this.mailbox = mailbox;
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
      if (msg[0] === 'EVENT' && msg[1] === this.pool.subId && msg[2]) this.pool._onEvent(msg[2], this);
      else if (msg[0] === 'EOSE' && msg[1] === this.pool.subId && this.mailbox) {
        this.pool.dispatchEvent(new CustomEvent('mailboxsynced', { detail: this.url }));
      }
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
    const since = Math.floor(Date.now() / 1000) - 60;
    const filters = chunks(this.pool.topics).map((t) => ({ kinds: [SIGNAL_KIND], '#t': t, since }));
    // Stored mail is only requested from the user's own mailbox relays.
    if (this.mailbox) for (const t of chunks(this.pool.mailTopics)) filters.push({ kinds: [MAIL_KIND], '#t': t, since: this.pool.mailSince });
    this.ws.send(JSON.stringify(['REQ', this.pool.subId, ...filters]));
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
    this.mailTopics = [];
    this.mailSince = Math.floor(Date.now() / 1000) - MAIL_TTL_S;
    this.seen = new Set();
  }

  /** @param urls signalling relays  @param mailboxUrls the user's own mailbox relays */
  setUrls(urls, mailboxUrls = []) {
    const valid = (u) => /^wss?:\/\//.test(u);
    const mail = new Set(mailboxUrls.filter(valid));
    const want = new Set([...urls.filter(valid), ...mail]);
    for (const [u, r] of this.relays) {
      if (!want.has(u) || r.mailbox !== mail.has(u)) { r.close(); this.relays.delete(u); }
    }
    for (const u of want) if (!this.relays.has(u)) this.relays.set(u, new Relay(this, u, mail.has(u)));
    this._status();
  }

  setTopics(topics, mailTopics = topics, mailSince = this.mailSince) {
    const t = [...new Set(topics)].sort();
    const m = [...new Set(mailTopics)].sort();
    if (t.join() === this.topics.join() && m.join() === this.mailTopics.join() && mailSince === this.mailSince) return;
    this.topics = t;
    this.mailTopics = m;
    this.mailSince = mailSince;
    for (const r of this.relays.values()) r.subscribe();
  }

  hasMailbox() {
    for (const r of this.relays.values()) if (r.mailbox && r.open) return true;
    return false;
  }

  /** @param topics one topic or several (the event reaches subscribers of any of them) */
  async publish(topics, content) {
    const ev = await nostrEvent(this.secret, this.pub, SIGNAL_KIND, tTags(topics), content);
    this.seen.add(ev.id);
    const msg = JSON.stringify(['EVENT', ev]);
    let sent = 0;
    for (const r of this.relays.values()) if (r.open) { r.send(msg); sent++; }
    return sent;
  }

  status() {
    let connected = 0, mailbox = 0, mailboxOpen = 0;
    for (const r of this.relays.values()) {
      if (r.open) connected++;
      if (r.mailbox) { mailbox++; if (r.open) mailboxOpen++; }
    }
    return { connected, total: this.relays.size, mailbox, mailboxOpen };
  }

  _status() {
    this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
  }

  _onEvent(ev, relay) {
    if (!ev || typeof ev.id !== 'string' || typeof ev.content !== 'string') return;
    if (ev.kind !== SIGNAL_KIND && !(ev.kind === MAIL_KIND && relay?.mailbox)) return;
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

/**
 * Ask a Walkie-Talkie relay (relay/server.mjs) for short-lived credentials for its TURN
 * server. Resolves with {servers: ["turn:host:3478?transport=udp user pass", …], ttl} or
 * throws with the relay's reason. Other Nostr relays don't know the request and time out.
 */
export function fetchTurn(url, accessCode = '', timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let ws, done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(t); try { ws?.close(); } catch {} err ? reject(err) : resolve(val); };
    const t = setTimeout(() => finish(new Error('no answer (is this a Walkie-Talkie relay?)')), timeoutMs);
    try { ws = new WebSocket(url); } catch { return finish(new Error('bad relay address')); }
    ws.onopen = () => ws.send(JSON.stringify(['TURN', accessCode]));
    ws.onerror = () => finish(new Error('could not reach the relay'));
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (!Array.isArray(msg) || msg[0] !== 'TURN') return;
      const c = msg[1];
      if (!c) return finish(new Error(String(msg[2] || 'refused').slice(0, 200)));
      const word = (x) => typeof x === 'string' && /^\S{1,256}$/.test(x);
      const urls = (Array.isArray(c.urls) ? c.urls : []).filter((u) => word(u) && /^turns?:/i.test(u)).slice(0, 4);
      if (!urls.length || !word(c.username) || !word(c.credential)) return finish(new Error('the relay sent unusable TURN details'));
      const ttl = Number.isFinite(c.ttl) && c.ttl > 60 ? Math.min(c.ttl, 7 * 86400) : 3600;
      finish(null, { servers: urls.map((u) => `${u} ${c.username} ${c.credential}`), ttl });
    };
  });
}

/**
 * Store an encrypted mail event on a contact's own mailbox relays. Opens a short-lived
 * connection to each and resolves with the number of relays that acknowledged it (NIP-20 OK).
 */
export async function postMail(urls, topics, content, timeoutMs = 10000) {
  const secret = randomSecret();
  const pub = hex(publicKey(secret));
  const expires = Math.floor(Date.now() / 1000) + MAIL_TTL_S;
  const ev = await nostrEvent(secret, pub, MAIL_KIND, [...tTags(topics), ['expiration', String(expires)]], content);
  const one = (url) => new Promise((resolve) => {
    let ws, done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); try { ws?.close(); } catch {} resolve(ok); };
    const t = setTimeout(() => finish(false), timeoutMs);
    try { ws = new WebSocket(url); } catch { return finish(false); }
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev]));
    ws.onmessage = (m) => {
      try { const msg = JSON.parse(m.data); if (msg[0] === 'OK' && msg[1] === ev.id) finish(msg[2] === true); } catch {}
    };
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
  const results = await Promise.all(urls.filter((u) => /^wss?:\/\//.test(u)).map(one));
  return results.filter(Boolean).length;
}
