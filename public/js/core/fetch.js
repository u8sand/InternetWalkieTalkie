// Fetches attachment chunks we're missing from connected peers.
//
// Every file referenced by a visible message is wanted until all of its chunks are held.
// Any connected member of the file's conversation (or one of our own devices) may have it;
// requests are spread across them, a peer that says it lacks a file is skipped for a while,
// one that sends a chunk that fails authentication is skipped for longer, and requests
// that go unanswered time out and go to someone else.

const TICK_MS = 1000;
const PER_PEER = 32;          // chunks in flight per peer (≈2 MB)
const MAX_WANT = 16;          // chunks per request
const TIMEOUT_MS = 15000;
const NO_HAVE_MS = 20000;   // until they announce they have it ('fhave')
const BAD_MS = 10 * 60000;

export class FileFetcher extends EventTarget {
  constructor(net, engine) {
    super();
    this.net = net;
    this.engine = engine;
    this.inflight = new Map(); // "id|i" -> {ek, at}
    this.skip = new Map();     // "id|ek" -> until (ms)
  }

  start() {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.engine.addEventListener('op', () => this.kick());
    this.engine.addEventListener('file', (e) => {
      if (!e.detail.done) return;
      for (const p of this.net.peers.values()) p.announceFile(e.detail.id);
    });
  }

  stop() { clearInterval(this.timer); }

  kick() {
    if (this._kicked) return;
    this._kicked = true;
    setTimeout(() => { this._kicked = false; this.tick(); }, 50);
  }

  attach(peer) {
    peer.addEventListener('fchunk', (e) => this._onChunk(peer, e.detail));
    peer.addEventListener('fnone', (e) => this._onNone(peer, e.detail));
    peer.addEventListener('fhave', (e) => { this.skip.delete(e.detail.id + '|' + peer.ek); this.kick(); });
    peer.addEventListener('ready', () => this.kick());
  }

  /** {have, total, waiting} for a file: waiting = nobody connected can send it right now. */
  status(id) {
    const p = this.engine.fileProgress(id);
    if (!p) return null;
    return { ...p, waiting: p.have < p.total && !this._candidates(id).length };
  }

  _candidates(id) {
    const ref = this.engine.fileRef(id);
    if (!ref) return [];
    const members = this.engine.convs.get(ref.conv).members;
    const now = Date.now();
    return [...this.net.peers.values()].filter((p) => p.authed && (p.ownDevice || members.includes(p.fp))
      && !((this.skip.get(id + '|' + p.ek) || 0) > now));
  }

  tick() {
    const files = this.engine.incompleteFiles();
    if (!files.length) return;
    const now = Date.now();
    const load = new Map();
    for (const [k, r] of this.inflight) {
      if (now - r.at > TIMEOUT_MS) { this.inflight.delete(k); continue; }
      load.set(r.ek, (load.get(r.ek) || 0) + 1);
    }
    for (const { file, missing } of files) {
      const cands = this._candidates(file.id);
      if (!cands.length) continue;
      const todo = missing.filter((i) => !this.inflight.has(file.id + '|' + i));
      let progress = true;
      while (todo.length && progress) {
        progress = false;
        for (const p of cands) {
          const room = Math.min(MAX_WANT, PER_PEER - (load.get(p.ek) || 0));
          if (room <= 0 || !todo.length) continue;
          const batch = todo.splice(0, room);
          for (const i of batch) this.inflight.set(file.id + '|' + i, { ek: p.ek, at: now });
          load.set(p.ek, (load.get(p.ek) || 0) + batch.length);
          p.requestChunks(file.id, batch);
          progress = true;
        }
      }
    }
  }

  _onChunk(peer, { id, i, ok }) {
    this.inflight.delete(id + '|' + i);
    if (!ok && !this.engine.chunks.get(id)?.has(i)) this.skip.set(id + '|' + peer.ek, Date.now() + BAD_MS);
    const p = this.engine.fileProgress(id);
    if (p) this.dispatchEvent(new CustomEvent('progress', { detail: { id, ...p } }));
    if (this._quiet(peer.ek)) this.kick();
  }

  _onNone(peer, { id, idx }) {
    for (const i of idx) this.inflight.delete(id + '|' + i);
    this.skip.set(id + '|' + peer.ek, Date.now() + NO_HAVE_MS);
    this.kick();
  }

  /** Top up a peer's queue once it's half drained. */
  _quiet(ek) {
    let n = 0;
    for (const r of this.inflight.values()) if (r.ek === ek) n++;
    return n <= PER_PEER / 2;
  }
}
