// One WebRTC DataChannel to one peer, plus the authentication handshake and the
// CRDT sync protocol that runs over it.
//
// Handshake: both sides send {t:'hi', card, dev, nonce}; then each signs
//   "iwt-auth-v1|<peer nonce>|<own DTLS fingerprint>|<peer DTLS fingerprint>"
// with its identity key. Binding the DTLS fingerprints proves no one is relaying
// the channel in the middle, whatever path the offer/answer took.
//
// Sync: {t:'sync', convs:{id: versionVector}} → each side answers with the ops
// the other is missing ({t:'ops', ops:[…]}). New local or relayed ops are pushed
// live to every connected member of the conversation (store-and-forward gossip).

import { sign, verify, importCard, authTranscript } from './crypto.js';
import { b64u, fromB64u, randomBytes } from './encoding.js';

const BATCH_BYTES = 48 * 1024;
const RESYNC_MS = 60000;
const debug = (...a) => { if (globalThis.IWT_DEBUG) console.log('[peer]', ...a); };

function dtlsFingerprint(sdp) {
  const m = /a=fingerprint:(\S+) (\S+)/i.exec(sdp || '');
  return m ? (m[1].toLowerCase() + ' ' + m[2].toUpperCase()) : '';
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
    dc.onopen = () => {
      if (this.helloSent) return;
      this.helloSent = true;
      this._send({ t: 'hi', card: this.engine.identity.card(), dev: this.engine.device, nonce: this.nonce, mb: this.engine.settings.mailboxRelays || [] });
    };
    dc.onclose = () => this.close();
    // Handle messages strictly in order (e.g. an address-book merge must finish before the
    // ops that depend on it are ingested).
    dc.onmessage = (e) => {
      this._rx = this._rx.then(() => this._onMessage(e.data)).catch((err) => console.warn('peer message error', err));
    };
    if (dc.readyState === 'open') dc.onopen();
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
    const convs = {};
    for (const id of this.engine.sharedConvs(this.remote.fp)) convs[id] = this.engine.vv(id);
    this._send({ t: 'sync', convs });
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
