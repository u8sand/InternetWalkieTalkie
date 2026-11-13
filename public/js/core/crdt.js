// Conversation CRDT.
//
// Each conversation is an op-based CRDT whose state is the *set* of signed ops
// (a grow-only set — merge is set union, so it is commutative, associative and
// idempotent). Every author numbers their ops 1,2,3… per conversation, so the
// set a replica holds is summarised exactly by a version vector
// {author: highest contiguous seq}. Two replicas sync by exchanging version
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
// CRDT, each replica keeps a per-author *floor*: the seq of that author's newest
// expired op, which is kept as a signed "watermark". Authors' timestamps never
// decrease, so the watermark proves every earlier op from that author has expired.
// The version vector counts from the floor, so peers stop asking for or resending
// expired history. A replica that was away longer than the retention period just
// receives the watermark and moves its floor up. State ops (group creation, renames)
// are pinned: they never expire, so membership and names survive.

export const PINNED_TYPES = new Set(['group', 'rename']);

export function compareOps(a, b) {
  return a.lamport - b.lamport || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || a.seq - b.seq;
}

export const msgId = (author, seq) => author + ':' + seq;

/** Per-conversation set of encrypted ops with version-vector bookkeeping. */
export class OpLog {
  constructor() {
    this.byAuthor = new Map(); // author -> Map<seq, env> (live ops, pinned ops, watermark)
    this.contig = new Map();   // author -> highest contiguous seq (counting from the floor)
    this.floors = new Map();   // author -> seq of the newest expired op (everything ≤ it is gone or pinned)
    this.pinned = new Set();   // keys of ops that never expire
  }

  floor(author) {
    return this.floors.get(author) || 0;
  }

  _recount(author) {
    const m = this.byAuthor.get(author) || new Map();
    let c = Math.max(this.contig.get(author) || 0, this.floor(author));
    while (m.has(c + 1)) c++;
    this.contig.set(author, c);
  }

  has(author, seq) {
    return !!this.byAuthor.get(author)?.has(seq);
  }

  get(author, seq) {
    return this.byAuthor.get(author)?.get(seq);
  }

  /** Returns true if the op was new. */
  add(env, pinned = false) {
    let m = this.byAuthor.get(env.author);
    if (!m) { m = new Map(); this.byAuthor.set(env.author, m); }
    if (m.has(env.seq)) return false;
    m.set(env.seq, env);
    if (pinned) this.pinned.add(msgId(env.author, env.seq));
    this._recount(env.author);
    return true;
  }

  /**
   * Raise an author's floor to `watermark` (an expired op already added to this log).
   * Returns the ops dropped: everything at or below it that isn't pinned, except the watermark.
   */
  advanceFloor(watermark) {
    const { author, seq } = watermark;
    if (seq <= this.floor(author)) return [];
    const m = this.byAuthor.get(author);
    const dropped = [];
    for (const [s, env] of m) {
      if (s < seq && !this.pinned.has(msgId(author, s))) { m.delete(s); dropped.push(env); }
    }
    this.floors.set(author, seq);
    this._recount(author);
    return dropped;
  }

  /** The newest op per author whose timestamp is at or before `cutoff` (candidate watermarks). */
  expiredHeads(cutoff) {
    const out = [];
    for (const [author, m] of this.byAuthor) {
      let best = null;
      for (const env of m.values()) if (env.ts <= cutoff && (!best || env.seq > best.seq)) best = env;
      if (best && best.seq > this.floor(author)) out.push(best);
    }
    return out;
  }

  nextSeq(author) {
    const m = this.byAuthor.get(author);
    const top = m && m.size ? Math.max(...m.keys()) : 0;
    return Math.max(top, this.floor(author)) + 1;
  }

  vv() {
    const out = {};
    for (const [a, c] of this.contig) if (c > 0) out[a] = c;
    return out;
  }

  /** Ops the holder of `remoteVV` is missing, in causal-friendly order. */
  since(remoteVV = {}) {
    const out = [];
    for (const [author, m] of this.byAuthor) {
      const have = Number.isSafeInteger(remoteVV[author]) ? remoteVV[author] : 0;
      for (const [seq, env] of m) if (seq > have) out.push(env);
    }
    return out.sort(compareOps);
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
      const id = msgId(env.author, env.seq);
      this.messages.delete(id);
      this.tombstones.delete(id);
    }
    this._sorted = null;
  }

  apply(env, body) {
    const id = msgId(env.author, env.seq);
    const ts = Number.isFinite(body.ts) ? body.ts : 0;
    switch (body.type) {
      case 'msg': {
        if (typeof body.text !== 'string') return;
        this.messages.set(id, {
          id, author: env.author, seq: env.seq, lamport: env.lamport, ts,
          text: body.text.slice(0, 20000), deleted: this.tombstones.has(id),
        });
        this._sorted = null;
        break;
      }
      case 'del': {
        // Only an author may delete their own messages.
        if (typeof body.target !== 'string' || !body.target.startsWith(env.author + ':')) return;
        this.tombstones.add(body.target);
        const m = this.messages.get(body.target);
        if (m) { m.deleted = true; m.text = ''; }
        break;
      }
      case 'group':
      case 'rename': {
        if (typeof body.name !== 'string') return;
        const stamp = { lamport: env.lamport, author: env.author, seq: env.seq };
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
