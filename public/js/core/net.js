// Network orchestration: presence over relays, WebRTC connection setup, manual
// (serverless) connection codes, and live fan-out of new ops to connected peers.

import { Peer } from './peer.js';
import { RelayPool, inboxTopic, utcDay, postMail, MAIL_KIND, MAIL_TTL_S } from './signaling.js';
import { sealSignal, openSignal } from './crypto.js';
import { pack, unpack } from './encoding.js';

const HELLO_EVERY_MS = 20000;
const debug = (...a) => { if (globalThis.IWT_DEBUG) console.log('[net]', ...a); };
const MAX_SKEW_MS = 120000;
const MAIL_RETRY_MS = 60000;
const MAIL_BATCH_BYTES = 32 * 1024;

export class Network extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.peers = new Map();   // fp -> ready Peer
    this.pending = new Map(); // sid -> Peer (connecting)
    this.lastHello = new Map();
    this.lastReply = new Map();
    this.nonces = new Set();
    this.mailing = new Set();     // fps with a mail flush in flight
    this.lastMailTry = new Map();
    this.pool = new RelayPool();
    this.pool.addEventListener('event', (e) => this._onRelayEvent(e.detail));
    this.pool.addEventListener('status', (e) => this._emit('relays', e.detail));
    this.pool.addEventListener('relayopen', () => this._presence(true));
    engine.addEventListener('op', (e) => { this._fanout(e.detail); if (e.detail.local) this._mailOffline(e.detail); });
    engine.addEventListener('change', (e) => {
      if (e.detail.what === 'contacts') { this._refreshTopics(); this._presence(true); }
    });
    engine.addEventListener('settings', () => { this._setRelays(); this._refreshTopics(); });
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _setRelays() {
    this.pool.setUrls(this.engine.settings.relays || [], this.engine.settings.mailboxRelays || []);
  }

  start() {
    this._setRelays();
    this._refreshTopics();
    this.timer = setInterval(() => { this._refreshTopics(); this._presence(); this._flushAllMail(); }, HELLO_EVERY_MS / 2);
    globalThis.addEventListener?.('online', () => { this._presence(true); this._flushAllMail(true); });
    this.processInbox();
  }

  /** Mail the service worker fetched in the background while the app was closed. */
  async processInbox() {
    const store = this.engine.store;
    for (const ev of (await store.all('inbox')) || []) {
      await this._onMail(ev);
      await store.del('inbox', ev.id);
    }
  }

  isOnline(fp) { return this.peers.has(fp); }

  onlineCount() { return this.peers.size; }

  async _refreshTopics() {
    const d = utcDay();
    const fp = this.engine.identity.fp;
    const days = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const live = await Promise.all(days(d - 1, d + 1).map((x) => inboxTopic(fp, x)));
    const mail = await Promise.all(days(d - 8, d + 1).map((x) => inboxTopic(fp, x)));
    const floor = Math.floor(Date.now() / 1000) - MAIL_TTL_S;
    // Re-read a little before the newest mail we saw, to tolerate relay clock skew.
    const since = Math.max(floor, (this.engine.mailSince || 0) - 3600);
    this.pool.setTopics(live, mail, since);
  }

  // ------------------------------------------------------------ relay signalling

  async _signal(fp, payload) {
    const k = this.engine.keyring.get(fp);
    if (!k) return;
    try {
      debug('send', payload.type, 'to', fp.slice(0, 8));
      const blob = await sealSignal(this.engine.identity, k, payload);
      await this.pool.publish(await inboxTopic(fp), blob);
    } catch (e) { console.warn('signal failed', e); }
  }

  /** Say hello to every known peer we're not connected to (they answer if online). */
  async _presence(force = false) {
    if (!this.pool.status().connected) return;
    const now = Date.now();
    for (const fp of this.engine.knownPeers()) {
      if (this.peers.has(fp) || this._connecting(fp)) continue;
      const last = this.lastHello.get(fp) || 0;
      if (!force && now - last < HELLO_EVERY_MS) continue;
      if (force && now - last < 3000) continue;
      this.lastHello.set(fp, now);
      this._signal(fp, this._hello());
    }
  }

  _hello() {
    return { type: 'hello', mb: this.engine.settings.mailboxRelays || [] };
  }

  _connecting(fp) {
    for (const p of this.pending.values()) if (p.fp === fp && p.state === 'connecting') return true;
    return false;
  }

  async _onRelayEvent(ev) {
    if (ev.kind === MAIL_KIND) return this._onMail(ev);
    let payload, sender;
    try { ({ payload, sender } = await openSignal(this.engine.identity, ev.content)); } catch { return; }
    if (Math.abs(Date.now() - payload.ts) > MAX_SKEW_MS) return;
    if (this.nonces.has(payload.nonce)) return; // replay
    this.nonces.add(payload.nonce);
    if (this.nonces.size > 5000) this.nonces = new Set([...this.nonces].slice(-2500));

    const fp = sender.fp;
    const me = this.engine.identity.fp;
    debug('signal', payload.type, 'from', fp.slice(0, 8));
    if (!this.engine.knownPeers().has(fp)) {
      // Someone who has our card wants to connect: surface it as a contact request.
      if (payload.type === 'hello') await this.engine.addRequest(sender.card);
      return;
    }
    this.engine.updatePeerCard(sender.card).catch(() => {});
    if (payload.type === 'hello' && Array.isArray(payload.mb)) this.engine.setPeerMailboxes(fp, payload.mb).catch(() => {});

    if (payload.type === 'hello') {
      // Peers only say hello when they are NOT connected to us, so a connection we still
      // think is open must be stale (e.g. they reloaded): drop it and reconnect.
      const stale = this.peers.get(fp);
      if (stale && Date.now() - stale.createdAt > 5000) stale.close();
      else if (stale) return;
      // Likewise an attempt that has been pending a while lost its offer/answer.
      for (const p of this.pending.values()) {
        if (p.fp === fp && p.state === 'connecting' && Date.now() - p.createdAt > 8000) p.close();
      }
      if (this._connecting(fp)) return;
      if (me < fp) {
        debug('offering to', fp.slice(0, 8));
        this._offer(fp);
      } else {
        // The lower fingerprint always makes the offer, so there's no glare:
        // just answer so they know we're online.
        const last = this.lastReply.get(fp) || 0;
        if (Date.now() - last > 2000) {
          this.lastReply.set(fp, Date.now());
          this._signal(fp, this._hello());
        }
      }
    } else if (payload.type === 'offer' && typeof payload.sdp === 'string') {
      if (me < fp) return; // we are supposed to be the offerer
      for (const p of this.pending.values()) if (p.fp === fp) p.close();
      const peer = this._newPeer({ initiator: false, expectedFp: fp, sid: String(payload.sid) });
      try {
        const sdp = await peer.makeAnswer(payload.sdp);
        this._signal(fp, { type: 'answer', sid: peer.sid, sdp });
      } catch (e) { peer.close(); }
    } else if (payload.type === 'answer' && typeof payload.sdp === 'string') {
      const peer = this.pending.get(String(payload.sid));
      if (peer && peer.expectedFp === fp) peer.acceptAnswer(payload.sdp).catch(() => peer.close());
    }
  }

  // ------------------------------------------------------------ offline mail

  /** A local op was created: queue it for every member who isn't connected and has a mailbox. */
  async _mailOffline({ env, conv }) {
    const c = this.engine.convs.get(conv);
    if (!c) return;
    for (const fp of c.members) {
      if (fp === this.engine.identity.fp || this.peers.has(fp)) continue;
      if (await this.engine.queueMail(fp, env)) this._flushMail(fp, true);
    }
  }

  _flushAllMail(force = false) {
    for (const fp of this.engine.outbox.keys()) this._flushMail(fp, force);
  }

  async _flushMail(fp, force = false) {
    if (this.mailing.has(fp)) return;
    if (this.peers.has(fp)) return this.engine.clearMail(fp); // live sync covers it
    const urls = this.engine.mailboxes.get(fp) || [];
    const k = this.engine.keyring.get(fp);
    if (!urls.length || !k) return;
    if (!force && Date.now() - (this.lastMailTry.get(fp) || 0) < MAIL_RETRY_MS) return;
    this.lastMailTry.set(fp, Date.now());
    this.mailing.add(fp);
    try {
      const pending = this.engine.pendingMail(fp);
      for (let i = 0; i < pending.length;) {
        const batch = [];
        let size = 0;
        while (i < pending.length && (batch.length === 0 || size + JSON.stringify(pending[i]).length < MAIL_BATCH_BYTES)) {
          size += JSON.stringify(pending[i]).length;
          batch.push(pending[i++]);
        }
        const blob = await sealSignal(this.engine.identity, k, { type: 'mail', ops: batch });
        const acked = await postMail(urls, await inboxTopic(fp), blob);
        debug('mailed', batch.length, 'ops to', fp.slice(0, 8), 'acked by', acked);
        if (!acked) break; // their relay is unreachable: retry later
        await this.engine.clearMail(fp, batch.map((e) => e.conv + '|' + e.author + '|' + e.seq));
      }
    } catch (e) { debug('mail failed', e); }
    finally { this.mailing.delete(fp); }
  }

  /** Encrypted mail from one of our own mailbox relays (live, on open, or fetched by the SW). */
  async _onMail(ev) {
    let payload, sender;
    try { ({ payload, sender } = await openSignal(this.engine.identity, ev.content)); } catch { return; }
    if (payload.type !== 'mail' || !Array.isArray(payload.ops)) return;
    if (Date.now() - payload.ts > (MAIL_TTL_S + 86400) * 1000) return;
    if (!this.engine.knownPeers().has(sender.fp)) return; // strangers can't mail us
    let added = 0;
    for (const env of payload.ops.slice(0, 500)) {
      if (env?.author !== sender.fp) continue; // only authors mail their own ops
      if ((await this.engine.ingest(env, sender.fp)).added) added++;
    }
    debug('mail from', sender.fp.slice(0, 8), 'added', added);
    if (Number.isSafeInteger(ev.created_at)) await this.engine.setMailSince(ev.created_at);
    if (added) this._emit('synced', { fp: sender.fp, added, via: 'mailbox' });
  }

  async _offer(fp) {
    const peer = this._newPeer({ initiator: true, expectedFp: fp });
    try {
      const sdp = await peer.makeOffer();
      if (peer.state === 'closed') return;
      this._signal(fp, { type: 'offer', sid: peer.sid, sdp });
    } catch (e) { debug('offer failed', e); peer.close(); }
  }

  // ------------------------------------------------------------ peers

  _newPeer(opts) {
    const peer = new Peer(this.engine, { timeoutMs: 20000, ...opts, iceServers: this.engine.settings.iceServers });
    this.pending.set(peer.sid, peer);
    peer.addEventListener('ready', async () => {
      this.pending.delete(peer.sid);
      const fp = peer.remote.fp;
      if (peer.manual && !this.engine.isContact(fp)) await this.engine.addContact(peer.remote.card);
      this.engine.updatePeerCard(peer.remote.card).catch(() => {});
      await this.engine.setPeerMailboxes(fp, peer.remoteMailboxes || []);
      await this.engine.clearMail(fp); // direct sync supersedes anything queued
      const old = this.peers.get(fp);
      this.peers.set(fp, peer);
      if (old && old !== peer) old.close();
      peer.sendSync();
      this._emit('peers', { fp, online: true });
    });
    peer.addEventListener('synced', (e) => this._emit('synced', { fp: peer.fp, ...e.detail }));
    peer.addEventListener('close', () => {
      this.pending.delete(peer.sid);
      if (peer.remote && this.peers.get(peer.remote.fp) === peer) {
        this.peers.delete(peer.remote.fp);
        this._emit('peers', { fp: peer.remote.fp, online: false });
        this.lastHello.delete(peer.remote.fp);
        setTimeout(() => this._presence(true), 1000);
      }
    });
    return peer;
  }

  /** Push a newly stored op to every connected member of its conversation except the source. */
  _fanout({ env, conv, source }) {
    const c = this.engine.convs.get(conv);
    if (!c) return;
    for (const fp of c.members) {
      if (fp === source || fp === this.engine.identity.fp) continue;
      this.peers.get(fp)?.sendOps([env]);
    }
  }

  // ------------------------------------------------------------ manual connection codes

  /** Step 1 (inviter): returns {code, sid}. Works with no relays — even offline on a LAN. */
  async createInvite() {
    const peer = this._newPeer({ initiator: true, manual: true, timeoutMs: 10 * 60000 });
    const sdp = await peer.makeOffer();
    return { sid: peer.sid, code: await pack({ t: 'iwt-offer', sid: peer.sid, sdp }) };
  }

  /** Step 2 (invitee) or step 3 (inviter): handle a pasted code. Returns a reply code or null. */
  async acceptCode(code) {
    const msg = await unpack(code);
    if (msg?.t === 'iwt-offer' && typeof msg.sdp === 'string') {
      const peer = this._newPeer({ initiator: false, manual: true, sid: String(msg.sid), timeoutMs: 10 * 60000 });
      const sdp = await peer.makeAnswer(msg.sdp);
      return await pack({ t: 'iwt-answer', sid: peer.sid, sdp });
    }
    if (msg?.t === 'iwt-answer' && typeof msg.sdp === 'string') {
      const peer = this.pending.get(String(msg.sid));
      if (!peer) throw new Error('That reply does not match an open invite (it may have expired).');
      await peer.acceptAnswer(msg.sdp);
      return null;
    }
    throw new Error('Not a connection code');
  }

  cancelPending(sid) {
    this.pending.get(sid)?.close();
  }

  stop() {
    clearInterval(this.timer);
    this.pool.close();
    for (const p of [...this.peers.values(), ...this.pending.values()]) p.close();
  }
}
