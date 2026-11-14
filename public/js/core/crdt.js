// Conversation CRDT.
//
// Each conversation is an op-based CRDT whose state is the *set* of signed ops
// (a grow-only set — merge is set union, so it is commutative, associative and
// idempotent). Every *stream* — one identity on one device, "author/dev" — numbers
// its ops 1,2,3… per conversation, so the set a replica holds is summarised exactly
// by a version vector {stream: highest contiguous seq}. Streams are per device so an
// identity cloned onto a phone and a laptop never reuses a sequence number. Two replicas sync by exchanging version
// vectors and sending each other the ops the other side is missing.
//
// The visible state (messages, deletions, group name) is a pure function of the
// op set: messages are totally ordered by (lamport, author, seq), deletions are
// tombstones that apply whenever they arrive, and the group name is a
// last-writer-wins register keyed on (lamport, author). Because nothing depends
// on arrival order, every replica holding the same ops shows the same chat.
//
// Expiry. Every conversation has an agreed retention period (fixed in the signed
// group-creation op, or a protocol default for direct chats). An op whose signed
// header timestamp is older than that is deleted everywhere. To stay a correct
// CRDT, each replica keeps a per-stream *floor*: the seq of that stream's newest
// expired op, which is kept as a signed "watermark". A device's timestamps never
// decrease, so the watermark proves every earlier op in that stream has expired.
// The version vector counts from the floor, so peers stop asking for or resending
// expired history. A replica that was away longer than the retention period just
// receives the watermark and moves its floor up. State ops (group creation, renames)
// are pinned: they never expire, so membership and names survive.
//
// Local deletion ("delete for me", clearing a chat) is not a CRDT operation: it changes
// only this user's replicas. A deleted message's op is replaced by a header-only *stub*
// that keeps its place in the version vector (so peers don't resend it) but holds no
// ciphertext and is never sent on.

import { cleanFileMeta } from './files.js';

export const PINNED_TYPES = new Set(['group', 'rename']);

const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

export function compareOps(a, b) {
  return a.lamport - b.lamport || cmp(a.author, b.author) || cmp(a.dev || '', b.dev || '') || a.seq - b.seq;
}

/** Version-vector key: one writer = one identity on one device. */
export const streamOf = (env) => env.author + '/' + env.dev;

/** Message id; starts with the author fingerprint so authorship checks stay simple. */
export const msgId = (env) => env.author + ':' + env.dev + ':' + env.seq;

/** Per-conversation set of encrypted ops with version-vector bookkeeping. */
export class OpLog {
  constructor() {
    this.byAuthor = new Map(); // stream -> Map<seq, env> (live ops, pinned ops, watermark)
    this.contig = new Map();   // stream -> highest contiguous seq (counting from the floor)
    this.floors = new Map();   // stream -> seq of the newest expired op (everything ≤ it is gone or pinned)
    this.pinned = new Set();   // keys of ops that never expire
  }

  floor(stream) {
    return this.floors.get(stream) || 0;
  }

  _recount(stream) {
    const m = this.byAuthor.get(stream) || new Map();
    let c = Math.max(this.contig.get(stream) || 0, this.floor(stream));
    while (m.has(c + 1)) c++;
    this.contig.set(stream, c);
  }

  has(stream, seq) {
    return !!this.byAuthor.get(stream)?.has(seq);
  }

  get(stream, seq) {
    return this.byAuthor.get(stream)?.get(seq);
  }

  /** Returns true if the op was new. */
  add(env, pinned = false) {
    const st = streamOf(env);
    let m = this.byAuthor.get(st);
    if (!m) { m = new Map(); this.byAuthor.set(st, m); }
    if (m.has(env.seq)) return false;
    m.set(env.seq, env);
    if (pinned) this.pinned.add(msgId(env));
    this._recount(st);
    return true;
  }

  /**
   * Raise an stream's floor to `watermark` (an expired op already added to this log).
   * Returns the ops dropped: everything at or below it that isn't pinned, except the watermark.
   */
  advanceFloor(watermark) {
    const st = streamOf(watermark);
    const { seq } = watermark;
    if (seq <= this.floor(st)) return [];
    const m = this.byAuthor.get(st);
    const dropped = [];
    for (const [s, env] of m) {
      if (s < seq && !this.pinned.has(msgId(env))) { m.delete(s); dropped.push(env); }
    }
    this.floors.set(st, seq);
    this._recount(st);
    return dropped;
  }

  /** The newest op per stream whose timestamp is at or before `cutoff` (candidate watermarks). */
  expiredHeads(cutoff) {
    const out = [];
    for (const [st, m] of this.byAuthor) {
      let best = null;
      for (const env of m.values()) if (env.ts <= cutoff && (!best || env.seq > best.seq)) best = env;
      if (best && best.seq > this.floor(st)) out.push(best);
    }
    return out;
  }

  nextSeq(stream) {
    const m = this.byAuthor.get(stream);
    const top = m && m.size ? Math.max(...m.keys()) : 0;
    return Math.max(top, this.floor(stream)) + 1;
  }

  vv() {
    const out = {};
    for (const [a, c] of this.contig) if (c > 0) out[a] = c;
    return out;
  }

  /**
   * Ops the holder of `remoteVV` is missing, in causal-friendly order. Stubs (ops this
   * replica deleted locally, keeping only the header) are never sent to peers; they are
   * included only when copying state to our own new device.
   */
  since(remoteVV = {}, includeStubs = false) {
    const out = [];
    for (const [st, m] of this.byAuthor) {
      const have = Number.isSafeInteger(remoteVV[st]) ? remoteVV[st] : 0;
      for (const [seq, env] of m) if (seq > have && (includeStubs || !env.stub)) out.push(env);
    }
    return out.sort(compareOps);
  }

  /** Swap a held op for its header-only stub (same stream and seq, so the version vector is unchanged). */
  replace(stub) {
    const m = this.byAuthor.get(streamOf(stub));
    if (m?.has(stub.seq)) m.set(stub.seq, stub);
  }

  get size() {
    let n = 0;
    for (const m of this.byAuthor.values()) n += m.size;
    return n;
  }
}

/** Materialised, order-independent view of one conversation's decrypted ops. */
export class ConversationView {
  constructor() {
    this.messages = new Map(); // id -> message
    this.tombstones = new Set();
    this.name = null;          // LWW register
    this.nameStamp = null;
    this._sorted = null;
  }

  /** Forget expired messages (their ops were pruned from the log). */
  remove(envs) {
    for (const env of envs) {
      const id = msgId(env);
      this.messages.delete(id);
      this.tombstones.delete(id);
    }
    this._sorted = null;
  }

  /** Drop a message from this replica's view only ("delete for me"). */
  hide(id) {
    if (this.messages.delete(id)) this._sorted = null;
  }

  apply(env, body) {
    const id = msgId(env);
    const ts = Number.isFinite(body.ts) ? body.ts : 0;
    switch (body.type) {
      case 'msg': {
        if (typeof body.text !== 'string') return;
        const file = body.file ? cleanFileMeta(body.file) : null;
        if (body.file && !file) return;
        const deleted = this.tombstones.has(id);
        this.messages.set(id, {
          id, author: env.author, dev: env.dev, seq: env.seq, lamport: env.lamport, ts,
          text: deleted ? '' : body.text.slice(0, 20000), file: deleted ? null : file, deleted,
        });
        this._sorted = null;
        break;
      }
      case 'del': {
        // Only an author may delete their own messages.
        if (typeof body.target !== 'string' || !body.target.startsWith(env.author + ':')) return;
        this.tombstones.add(body.target);
        const m = this.messages.get(body.target);
        if (m) { m.deleted = true; m.text = ''; m.file = null; }
        break;
      }
      case 'group':
      case 'rename': {
        if (typeof body.name !== 'string') return;
        const stamp = { lamport: env.lamport, author: env.author, dev: env.dev, seq: env.seq };
        if (!this.nameStamp || compareOps(this.nameStamp, stamp) < 0) {
          this.name = body.name.slice(0, 80);
          this.nameStamp = stamp;
        }
        break;
      }
      default:
        // Unknown types are kept in the op set (so they still replicate) but not shown.
        break;
    }
  }

  list() {
    if (!this._sorted) this._sorted = [...this.messages.values()].sort(compareOps);
    return this._sorted;
  }

  last() {
    const l = this.list();
    for (let i = l.length - 1; i >= 0; i--) if (!l[i].deleted) return l[i];
    return null;
  }
}
