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

export function compareOps(a, b) {
  return a.lamport - b.lamport || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || a.seq - b.seq;
}

export const msgId = (author, seq) => author + ':' + seq;

/** Per-conversation set of encrypted ops with version-vector bookkeeping. */
export class OpLog {
  constructor() {
    this.byAuthor = new Map(); // author -> Map<seq, env>
    this.contig = new Map();   // author -> highest contiguous seq
  }

  has(author, seq) {
    return !!this.byAuthor.get(author)?.has(seq);
  }

  get(author, seq) {
    return this.byAuthor.get(author)?.get(seq);
  }

  /** Returns true if the op was new. */
  add(env) {
    let m = this.byAuthor.get(env.author);
    if (!m) { m = new Map(); this.byAuthor.set(env.author, m); }
    if (m.has(env.seq)) return false;
    m.set(env.seq, env);
    let c = this.contig.get(env.author) || 0;
    while (m.has(c + 1)) c++;
    this.contig.set(env.author, c);
    return true;
  }

  nextSeq(author) {
    const m = this.byAuthor.get(author);
    if (!m || m.size === 0) return 1;
    return Math.max(...m.keys()) + 1;
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
