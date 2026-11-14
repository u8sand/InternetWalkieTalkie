// One WebRTC DataChannel to one peer, plus the authentication handshake and the
// CRDT sync protocol that runs over it.
//
// Handshake: the channel's creator sends {t:'hi', card, dev, nonce} and the other side
// replies with its own (never first: see _setup); then each signs
//   "iwt-auth-v1|<peer nonce>|<own DTLS fingerprint>|<peer DTLS fingerprint>"
// with its identity key. Binding the DTLS fingerprints proves no one is relaying
// the channel in the middle, whatever path the offer/answer took.
//
// Sync: {t:'sync', convs:{id: versionVector}} → each side answers with the ops
// the other is missing ({t:'ops', ops:[…]}). New local or relayed ops are pushed
// live to every connected member of the conversation (store-and-forward gossip).
//
// Receipts: the version vectors in 'sync' already show which ops the peer holds
// (delivered). {t:'rcpt', list:[{conv, fp, got, read, sig}]} reports changes promptly;
// 'read' is the Lamport mark of what fp has seen. Receipts are signed by fp, so in groups
// members pass on each other's. {t:'typing', conv, on} is ephemeral.

import { sign, verify, importCard, authTranscript } from './crypto.js';
import { b64u, fromB64u, randomBytes } from './encoding.js';

const MAX_WANT = 16; // chunks per request

const BATCH_BYTES = 48 * 1024;
const RESYNC_MS = 60000;
const debug = (...a) => { if (globalThis.IWT_DEBUG) console.log('[peer]', ...a); };

/**
 * The DTLS certificate fingerprint an SDP commits to. Authentication signs this value, so it
 * must be the one the browser actually enforces: an SDP naming more than one fingerprint
 * (a decoy next to the real one) is refused outright rather than guessed at.
 */
export function dtlsFingerprint(sdp) {
  const all = new Set();
  for (const m of String(sdp || '').matchAll(/^a=fingerprint:(\S+) (\S+)\s*$/gim)) all.add(m[1].toLowerCase() + ' ' + m[2].toUpperCase());
  return all.size === 1 ? [...all][0] : '';
}

function waitForIce(pc, ms = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class Peer extends EventTarget {
  /**
   * @param engine
   * @param opts {initiator, expectedFp?, expectedDev?, manual?, iceServers, sid}
   */
  constructor(engine, opts) {
    super();
    this.engine = engine;
    this.initiator = !!opts.initiator;
    this.expectedFp = opts.expectedFp || null;
    this.expectedDev = opts.expectedDev || null;
    this.dev = this.expectedDev;
    this._rx = Promise.resolve();
    this.manual = !!opts.manual;
    this.sid = opts.sid || b64u(randomBytes(9));
    this.state = 'connecting';
    this.remote = null;       // key bundle after 'hi'
    this.remoteNonce = null;
    this.nonce = b64u(randomBytes(16));
    this.authed = false;
    this.createdAt = Date.now();
    this.pc = new RTCPeerConnection({ iceServers: (opts.iceServers || []).map((u) => ({ urls: u })) });
    this.pc.onconnectionstatechange = () => {
      debug('connection', this.pc.connectionState);
      if (['failed', 'closed'].includes(this.pc.connectionState)) this.close();
    };
    if (this.initiator) {
      this._setup(this.pc.createDataChannel('iwt', { ordered: true }));
    } else {
      this.pc.ondatachannel = (e) => this._setup(e.channel);
    }
    this.timeout = setTimeout(() => { if (this.state !== 'ready') this.close(); }, opts.timeoutMs || 45000);
  }

  get fp() { return this.remote?.fp || this.expectedFp; }

  /** Endpoint key: one identity on one device. */
  get ek() { return this.fp + '/' + this.dev; }

  /** Is this a connection between two devices of the same identity? */
  get ownDevice() { return this.fp === this.engine.identity.fp; }

  async makeOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForIce(this.pc);
    return this.pc.localDescription.sdp;
  }

  async makeAnswer(offerSdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForIce(this.pc);
    return this.pc.localDescription.sdp;
  }

  async acceptAnswer(answerSdp) {
    if (this.pc.signalingState !== 'have-local-offer') return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  _setup(dc) {
    this.dc = dc;
    dc.bufferedAmountLowThreshold = 256 * 1024;
    // Only the side that created the channel speaks first. The answering side's channel can
    // report "open" before the initiator's does, and Chromium may drop a message that lands
    // in that window — so the answerer sends its hi only in reply to the initiator's.
    dc.onopen = () => { if (this.initiator) this._sendHi(); };
    dc.onclose = () => this.close();
    // Handle messages strictly in order (e.g. an address-book merge must finish before the
    // ops that depend on it are ingested).
    dc.onmessage = (e) => {
      this._rx = this._rx.then(() => this._onMessage(e.data)).catch((err) => console.warn('peer message error', err));
    };
    if (dc.readyState === 'open') dc.onopen();
  }

  _sendHi() {
    if (this.helloSent) return;
    this.helloSent = true;
    this._send({ t: 'hi', card: this.engine.identity.card(), dev: this.engine.device, nonce: this.nonce, mb: this.engine.settings.mailboxRelays || [] });
  }

  _send(obj) {
    if (this.dc?.readyState !== 'open') return false;
    this.dc.send(JSON.stringify(obj));
    return true;
  }

  async _drain() {
    if (!this.dc || this.dc.bufferedAmount < 1024 * 1024) return;
    await new Promise((r) => this.dc.addEventListener('bufferedamountlow', r, { once: true }));
  }

  async _onMessage(data) {
    if (typeof data !== 'string' || data.length > 1024 * 1024) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    debug('recv', msg.t);

    if (msg.t === 'hi') {
      if (this.remote) return;
      this._sendHi(); // answerer: reply now that both ends are open
      let k;
      try { k = await importCard(msg.card); } catch { return this.close(); }
      const dev = String(msg.dev || '');
      if (!/^[0-9a-f]{16}$/.test(dev)) return this.close();
      if (this.expectedFp && k.fp !== this.expectedFp) return this.close();
      if (this.expectedDev && dev !== this.expectedDev) return this.close();
      const me = this.engine.identity.fp;
      if (k.fp === me && dev === this.engine.device) return this.close(); // ourselves
      if (k.fp !== me && !this.manual && !this.engine.knownPeers().has(k.fp)) return this.close();
      this.dev = dev;
      this.remote = k;
      this.remoteNonce = String(msg.nonce || '');
      this.remoteMailboxes = Array.isArray(msg.mb) ? msg.mb : [];
      const local = dtlsFingerprint(this.pc.localDescription?.sdp);
      const remote = dtlsFingerprint(this.pc.remoteDescription?.sdp);
      if (!local || !remote) return this.close();
      const sig = await sign(this.engine.identity, authTranscript(this.remoteNonce, local, remote));
      this._send({ t: 'auth', sig: b64u(sig) });
      return;
    }

    if (msg.t === 'auth') {
      if (!this.remote || this.authed) return;
      const local = dtlsFingerprint(this.pc.localDescription?.sdp);
      const remote = dtlsFingerprint(this.pc.remoteDescription?.sdp);
      let ok = false;
      try { ok = await verify(this.remote.signKey, fromB64u(msg.sig), authTranscript(this.nonce, remote, local)); } catch {}
      if (!ok || !local || !remote) return this.close();
      this.authed = true;
      this.state = 'ready';
      clearTimeout(this.timeout);
      this.dispatchEvent(new CustomEvent('ready', { detail: this }));
      this.resync = setInterval(() => this.sendSync(), RESYNC_MS);
      return;
    }

    if (!this.authed) return;

    if (msg.t === 'mine' && this.ownDevice) {
      // Another device of ours: merge address book and profile.
      await this.engine.mergeOwnDevice(msg.summary);
      return;
    }

    if (msg.t === 'sync' && msg.convs && typeof msg.convs === 'object') {
      const shared = this.engine.sharedConvs(this.remote.fp);
      const batch = [];
      for (const id of shared) {
        const vv = msg.convs[id];
        batch.push(...this.engine.missingFor(id, vv && typeof vv === 'object' ? vv : {}));
      }
      await this.sendOps(batch);
      if (!this.ownDevice) {
        const rd = msg.rd && typeof msg.rd === 'object' ? msg.rd : {};
        for (const id of shared) {
          const vv = msg.convs[id];
          if (vv && typeof vv === 'object') await this.engine.noteReceipt(id, this.remote.fp, { got: vv, read: rd[id] });
        }
      }
      return;
    }

    if (msg.t === 'rcpt' && Array.isArray(msg.list)) {
      const shared = new Set(this.engine.sharedConvs(this.remote.fp));
      const fresh = [];
      for (const r of msg.list.slice(0, 512)) {
        if (shared.has(r?.conv) && (await this.engine.ingestSignedReceipt(r))) fresh.push(r);
      }
      if (fresh.length) this.dispatchEvent(new CustomEvent('receipts', { detail: fresh }));
      return;
    }

    // Attachments: {t:'fwant', id, idx:[…]} → one {t:'fchunk', id, i, d} per chunk we hold,
    // then {t:'fnone', id, idx:[…]} listing any we don't.
    if (msg.t === 'fwant' && typeof msg.id === 'string' && Array.isArray(msg.idx)) {
      if (!this.engine.canServe(msg.id, this.remote.fp)) return this._send({ t: 'fnone', id: msg.id, idx: msg.idx.slice(0, MAX_WANT) });
      const none = [];
      for (const i of msg.idx.slice(0, MAX_WANT)) {
        const ct = Number.isSafeInteger(i) ? await this.engine.readChunk(msg.id, i) : null;
        if (!ct) { none.push(i); continue; }
        await this._drain();
        this._send({ t: 'fchunk', id: msg.id, i, d: b64u(ct) });
      }
      if (none.length) this._send({ t: 'fnone', id: msg.id, idx: none });
      return;
    }

    if (msg.t === 'fchunk' && typeof msg.id === 'string' && typeof msg.d === 'string') {
      let ct;
      try { ct = fromB64u(msg.d); } catch { return; }
      const ok = await this.engine.putChunk(msg.id, msg.i, ct);
      this.dispatchEvent(new CustomEvent('fchunk', { detail: { id: msg.id, i: msg.i, ok } }));
      return;
    }

    if (msg.t === 'fhave' && typeof msg.id === 'string') {
      this.dispatchEvent(new CustomEvent('fhave', { detail: { id: msg.id } }));
      return;
    }

    if (msg.t === 'fnone' && typeof msg.id === 'string' && Array.isArray(msg.idx)) {
      this.dispatchEvent(new CustomEvent('fnone', { detail: { id: msg.id, idx: msg.idx.slice(0, MAX_WANT) } }));
      return;
    }

    if (msg.t === 'typing' && !this.ownDevice && typeof msg.conv === 'string') {
      if (this.engine.convs.get(msg.conv)?.members.includes(this.remote.fp)) {
        this.dispatchEvent(new CustomEvent('typing', { detail: { fp: this.remote.fp, conv: msg.conv, on: !!msg.on } }));
      }
      return;
    }

    if (msg.t === 'ops' && Array.isArray(msg.ops)) {
      let added = 0;
      for (const env of msg.ops) {
        const conv = this.engine.convs.get(env?.conv);
        // Only accept ops for conversations the sender belongs to (or ones we're about to learn).
        if (conv && !conv.members.includes(this.remote.fp)) continue;
        const r = await this.engine.ingest(env, this.ek);
        if (r.added) added++;
      }
      if (added) this.dispatchEvent(new CustomEvent('synced', { detail: { added } }));
      return;
    }
  }

  sendSync() {
    if (!this.authed) return;
    if (this.ownDevice) this._send({ t: 'mine', summary: this.engine.ownDeviceSummary() });
    const convs = {}, rd = {};
    for (const id of this.engine.sharedConvs(this.remote.fp)) {
      const r = this.engine.myReceipt(id);
      convs[id] = r.got;
      if (r.read) rd[id] = r.read;
    }
    this._send({ t: 'sync', convs, ...(this.ownDevice ? {} : { rd }) });
  }

  /**
   * Tell the peer what we now hold and have read in these conversations, plus (in groups)
   * other members' receipts we can pass on.
   */
  async sendReceipts(convIds, { relayed = false } = {}) {
    if (!this.authed || this.ownDevice || !convIds.length) return;
    const list = [];
    for (const id of convIds) {
      list.push(await this.engine.signedReceipt(id));
      if (relayed) for (const r of this.engine.relayReceipts(id)) if (r.fp !== this.remote.fp) list.push(r);
    }
    this.sendSigned(list);
  }

  sendSigned(list) {
    if (this.authed && !this.ownDevice && list.length) this._send({ t: 'rcpt', list });
  }

  /** We now hold all of a file: anyone who asked us too early can ask again. */
  announceFile(id) {
    if (this.authed && this.engine.canServe(id, this.remote.fp)) this._send({ t: 'fhave', id });
  }

  requestChunks(id, idx) {
    return this._send({ t: 'fwant', id, idx: idx.slice(0, MAX_WANT) });
  }

  sendTyping(conv, on) {
    if (this.authed && !this.ownDevice) this._send({ t: 'typing', conv, on });
  }

  async sendOps(ops) {
    let batch = [], size = 0;
    for (const env of ops) {
      const s = JSON.stringify(env).length;
      if (batch.length && size + s > BATCH_BYTES) {
        await this._drain();
        this._send({ t: 'ops', ops: batch });
        batch = []; size = 0;
      }
      batch.push(env); size += s;
    }
    if (batch.length) { await this._drain(); this._send({ t: 'ops', ops: batch }); }
  }

  close() {
    if (this.state === 'closed') return;
    debug('close', this.sid, 'was', this.state, new Error().stack.split('\n')[2]?.trim());
    this.state = 'closed';
    clearTimeout(this.timeout);
    clearInterval(this.resync);
    try { this.dc?.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.dispatchEvent(new CustomEvent('close', { detail: this }));
  }
}
