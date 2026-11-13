// The engine owns identity, contacts, conversations and the CRDT op logs.
// It knows nothing about networking: the network layer feeds it ops via ingest()
// and asks it which ops a peer is missing.

import {
  generateIdentity, importIdentity, exportIdentity, importCard, sealOp, openOp, verifyOp,
  isWellFormedOp, encryptBackup, decryptBackup,
} from './crypto.js';
import { OpLog, ConversationView, msgId } from './crdt.js';
import { utf8, hex, sha256, b64u, randomBytes } from './encoding.js';

export const DEFAULT_SETTINGS = {
  relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom'],
  iceServers: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  notifications: false,
};

const opKey = (env) => env.conv + '|' + env.author + '|' + env.seq;

export async function directConvId(a, b) {
  const [x, y] = [a, b].sort();
  return 'd:' + hex(await sha256(utf8('iwt-direct|' + x + '|' + y))).slice(0, 40);
}

export async function groupConvId(creator, nonce) {
  return 'g:' + hex(await sha256(utf8('iwt-group|' + creator + '|' + nonce))).slice(0, 40);
}

export class Engine extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.identity = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.keyring = new Map();   // fp -> {fp, name, signKey, dhKey, card}: everyone whose keys we hold
    this.contacts = new Map();  // fp -> {fp, card, nick, addedAt}
    this.requests = new Map();  // fp -> {fp, card, at}
    this.convs = new Map();     // id -> {id, kind, members, memberCards, createdBy, createdAt, readUpTo}
    this.logs = new Map();      // id -> OpLog
    this.views = new Map();     // id -> ConversationView
    this.clock = 0;             // Lamport clock
    this._queue = Promise.resolve();
  }

  /** Serialise all mutations so async gaps can't interleave seq allocation or conv creation. */
  _serial(fn) {
    const p = this._queue.then(fn, fn);
    this._queue = p.catch(() => {});
    return p;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ------------------------------------------------------------ lifecycle

  async load() {
    const stored = await this.store.get('kv', 'identity');
    if (!stored) return false;
    this.identity = await importIdentity(stored);
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.store.get('kv', 'settings')) || {}) };
    this._addKey({ fp: this.identity.fp, name: this.identity.name, signKey: this.identity.signPub, dhKey: this.identity.dhPub, card: this.identity.card() });

    for (const c of await this.store.all('contacts')) {
      try {
        this._addKey(await importCard(c.card));
        this.contacts.set(c.fp, c);
      } catch (e) { console.warn('bad stored contact', e); }
    }
    for (const r of await this.store.all('requests')) this.requests.set(r.fp, r);
    for (const conv of await this.store.all('convs')) {
      for (const card of Object.values(conv.memberCards || {})) {
        if (!this.keyring.has(card.fp)) {
          try { this._addKey(await importCard(card.card), true); } catch {}
        }
      }
      this._registerConv(conv);
    }
    const ops = await this.store.all('ops');
    for (const env of ops) {
      const conv = this.convs.get(env.conv);
      if (!conv) continue;
      try {
        const body = await openOp(this.identity, env);
        this._applyOp(env, body);
      } catch (e) { console.warn('stored op unreadable', e); }
    }
    return true;
  }

  async createIdentity(name) {
    this.identity = await generateIdentity(name.trim().slice(0, 64) || 'Anonymous');
    await this.store.put('kv', 'identity', await exportIdentity(this.identity));
    await this.store.put('kv', 'settings', this.settings);
    this._addKey({ fp: this.identity.fp, name: this.identity.name, signKey: this.identity.signPub, dhKey: this.identity.dhPub, card: this.identity.card() });
    return this.identity;
  }

  async setName(name) {
    this.identity.name = name.trim().slice(0, 64) || this.identity.name;
    await this.store.put('kv', 'identity', await exportIdentity(this.identity));
    this.keyring.get(this.identity.fp).name = this.identity.name;
    this._emit('change', { what: 'identity' });
  }

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    await this.store.put('kv', 'settings', this.settings);
    this._emit('settings', this.settings);
  }

  // ------------------------------------------------------------ keys & contacts

  _addKey(k, keepName = false) {
    const existing = this.keyring.get(k.fp);
    if (existing && keepName) return existing;
    this.keyring.set(k.fp, { ...existing, ...k });
    return this.keyring.get(k.fp);
  }

  displayName(fp) {
    if (this.identity && fp === this.identity.fp) return this.identity.name + ' (you)';
    const c = this.contacts.get(fp);
    if (c?.nick) return c.nick;
    const k = this.keyring.get(fp);
    return (k?.name || c?.card?.n || this.requests.get(fp)?.card?.n) || fp.slice(0, 8);
  }

  isContact(fp) { return this.contacts.has(fp); }

  /** Peers we are willing to open connections with: contacts + members of our groups. */
  knownPeers() {
    const out = new Set(this.contacts.keys());
    for (const conv of this.convs.values()) for (const m of conv.members) out.add(m);
    out.delete(this.identity.fp);
    return out;
  }

  async addContact(card) {
    const k = await importCard(card);
    if (k.fp === this.identity.fp) throw new Error("That's your own card");
    return this._serial(async () => {
      this._addKey(k);
      const existing = this.contacts.get(k.fp);
      const c = { fp: k.fp, card: k.card, nick: existing?.nick || '', addedAt: existing?.addedAt || Date.now() };
      this.contacts.set(k.fp, c);
      await this.store.put('contacts', k.fp, c);
      if (this.requests.delete(k.fp)) await this.store.del('requests', k.fp);
      await this._ensureDirectConv(k.fp);
      this._emit('change', { what: 'contacts' });
      return c;
    });
  }

  /** A peer presented a fresh card (e.g. they renamed themselves). */
  async updatePeerCard(card) {
    const k = await importCard(card);
    const known = this.keyring.get(k.fp);
    if (!known || known.name === k.name) return;
    known.name = k.name;
    known.card = k.card;
    const c = this.contacts.get(k.fp);
    if (c) { c.card = k.card; await this.store.put('contacts', k.fp, c); }
    this._emit('change', { what: 'contacts' });
  }

  async setNick(fp, nick) {
    const c = this.contacts.get(fp);
    if (!c) return;
    c.nick = nick.trim().slice(0, 64);
    await this.store.put('contacts', fp, c);
    this._emit('change', { what: 'contacts' });
  }

  async removeContact(fp) {
    if (!this.contacts.delete(fp)) return;
    await this.store.del('contacts', fp);
    this._emit('change', { what: 'contacts' });
  }

  async addRequest(card) {
    const k = await importCard(card);
    if (this.contacts.has(k.fp) || k.fp === this.identity.fp) return false;
    const isNew = !this.requests.has(k.fp);
    const r = { fp: k.fp, card: k.card, at: Date.now() };
    this.requests.set(k.fp, r);
    await this.store.put('requests', k.fp, r);
    if (isNew) this._emit('change', { what: 'requests', fp: k.fp });
    return isNew;
  }

  async dismissRequest(fp) {
    this.requests.delete(fp);
    await this.store.del('requests', fp);
    this._emit('change', { what: 'requests' });
  }

  // ------------------------------------------------------------ conversations

  _registerConv(conv) {
    this.convs.set(conv.id, conv);
    if (!this.logs.has(conv.id)) this.logs.set(conv.id, new OpLog());
    if (!this.views.has(conv.id)) this.views.set(conv.id, new ConversationView());
  }

  async _ensureDirectConv(fp) {
    const id = await directConvId(this.identity.fp, fp);
    if (this.convs.has(id)) return this.convs.get(id);
    const k = this.keyring.get(fp);
    const conv = {
      id, kind: 'direct', members: [this.identity.fp, fp].sort(),
      memberCards: { [fp]: { fp, card: k.card } }, createdAt: Date.now(), readUpTo: 0,
    };
    this._registerConv(conv);
    await this.store.put('convs', id, conv);
    return conv;
  }

  async directConv(fp) {
    return this._serial(() => this._ensureDirectConv(fp));
  }

  convTitle(conv) {
    if (conv.kind === 'group') return this.views.get(conv.id)?.name || 'Group';
    const other = conv.members.find((m) => m !== this.identity.fp);
    return this.displayName(other);
  }

  conversations() {
    return [...this.convs.values()].map((conv) => {
      const view = this.views.get(conv.id);
      const last = view.last();
      const unread = view.list().filter((m) => m.author !== this.identity.fp && !m.deleted && m.lamport > (conv.readUpTo || 0)).length;
      return { conv, title: this.convTitle(conv), last, unread, sortKey: last ? last.ts : conv.createdAt };
    }).sort((a, b) => b.sortKey - a.sortKey);
  }

  async markRead(convId) {
    const conv = this.convs.get(convId);
    const last = this.views.get(convId)?.list().at(-1);
    if (!conv || !last || (conv.readUpTo || 0) >= last.lamport) return;
    conv.readUpTo = last.lamport;
    await this.store.put('convs', convId, conv);
    this._emit('change', { what: 'read', conv: convId });
  }

  async createGroup(name, memberFps) {
    const members = [...new Set([this.identity.fp, ...memberFps])];
    if (members.length < 2) throw new Error('A group needs at least one other member');
    for (const m of members) if (!this.keyring.has(m)) throw new Error('Unknown member ' + m);
    return this._serial(async () => {
      const nonce = b64u(randomBytes(16));
      const id = await groupConvId(this.identity.fp, nonce);
      const memberCards = {};
      for (const m of members) memberCards[m] = { fp: m, card: this.keyring.get(m).card };
      const conv = { id, kind: 'group', members: members.sort(), memberCards, createdBy: this.identity.fp, createdAt: Date.now(), readUpTo: 0 };
      this._registerConv(conv);
      await this.store.put('convs', id, conv);
      await this._send(id, {
        type: 'group', name: name.trim().slice(0, 80) || 'Group', nonce,
        members: members.map((m) => memberCards[m].card), ts: Date.now(),
      });
      return conv;
    });
  }

  sendText(convId, text) {
    text = String(text).slice(0, 20000);
    if (!text.trim()) return Promise.resolve(null);
    return this._serial(() => this._send(convId, { type: 'msg', text, ts: Date.now() }));
  }

  deleteMessage(convId, id) {
    if (!id.startsWith(this.identity.fp + ':')) throw new Error('You can only delete your own messages');
    return this._serial(() => this._send(convId, { type: 'del', target: id, ts: Date.now() }));
  }

  renameGroup(convId, name) {
    return this._serial(() => this._send(convId, { type: 'rename', name: String(name).slice(0, 80), ts: Date.now() }));
  }

  async _send(convId, body) {
    const conv = this.convs.get(convId);
    if (!conv) throw new Error('unknown conversation');
    const log = this.logs.get(convId);
    const recipients = conv.members.map((fp) => this.keyring.get(fp)).filter(Boolean);
    const env = await sealOp(this.identity, recipients, {
      conv: convId, seq: log.nextSeq(this.identity.fp), lamport: this.clock + 1,
    }, body);
    await this.store.put('ops', opKey(env), env);
    this._applyOp(env, body);
    this._emit('op', { env, body, conv: convId, local: true });
    return env;
  }

  _applyOp(env, body) {
    const log = this.logs.get(env.conv);
    if (!log.add(env)) return false;
    this.views.get(env.conv).apply(env, body);
    if (env.lamport > this.clock) this.clock = env.lamport;
    return true;
  }

  // ------------------------------------------------------------ sync surface

  /** Conversations a given peer is a member of (the only ones we ever tell them about). */
  sharedConvs(fp) {
    return [...this.convs.values()].filter((c) => c.members.includes(fp)).map((c) => c.id);
  }

  vv(convId) {
    return this.logs.get(convId)?.vv() || {};
  }

  missingFor(convId, remoteVV) {
    return this.logs.get(convId)?.since(remoteVV) || [];
  }

  /**
   * Validate, decrypt, verify and merge an op received from the network.
   * Returns {added: boolean, reason?: string}.
   */
  ingest(env, source) {
    return this._serial(() => this._ingest(env, source));
  }

  async _ingest(env, source) {
    if (!isWellFormedOp(env)) return { added: false, reason: 'malformed' };
    // A member could otherwise pin everyone's Lamport clock near 2^53.
    if (env.lamport > this.clock + 1e6) return { added: false, reason: 'lamport out of range' };
    const me = this.identity.fp;
    let conv = this.convs.get(env.conv);
    if (conv && this.logs.get(env.conv).has(env.author, env.seq)) return { added: false, reason: 'duplicate' };
    if (typeof env.keys[me] !== 'string') return { added: false, reason: 'not addressed to us' };

    let body;
    try { body = await openOp(this.identity, env); } catch { return { added: false, reason: 'decrypt failed' }; }
    if (!body || typeof body.type !== 'string') return { added: false, reason: 'bad body' };

    let newConv = null;
    if (!conv) {
      if (env.conv.startsWith('d:')) {
        if (!this.keyring.has(env.author) || env.author === me) return { added: false, reason: 'unknown author' };
        if ((await directConvId(me, env.author)) !== env.conv) return { added: false, reason: 'bad direct id' };
        const k = this.keyring.get(env.author);
        newConv = {
          id: env.conv, kind: 'direct', members: [me, env.author].sort(),
          memberCards: { [env.author]: { fp: env.author, card: k.card } }, createdAt: Date.now(), readUpTo: 0,
        };
      } else if (env.conv.startsWith('g:')) {
        newConv = await this._groupFromOp(env, body);
        if (!newConv) return { added: false, reason: 'unknown group' };
      } else {
        return { added: false, reason: 'bad conv id' };
      }
    }
    const c = conv || newConv;
    if (!c.members.includes(env.author)) return { added: false, reason: 'author not a member' };
    if (body.type === 'group' && (env.author !== c.createdBy || env.seq !== 1)) return { added: false, reason: 'forged group op' };
    const authorKey = newConv?._keys?.get(env.author) || this.keyring.get(env.author);
    if (!authorKey || !(await verifyOp(env, authorKey.signKey))) return { added: false, reason: 'bad signature' };

    if (newConv) {
      const keys = newConv._keys;
      delete newConv._keys;
      if (keys) for (const k of keys.values()) if (!this.keyring.has(k.fp)) this._addKey(k);
      this._registerConv(newConv);
      await this.store.put('convs', newConv.id, newConv);
    }
    await this.store.put('ops', opKey(env), env);
    this._applyOp(env, body);
    this._emit('op', { env, body, conv: env.conv, source, local: false });
    if (newConv) this._emit('change', { what: 'convs' });
    return { added: true };
  }

  async _groupFromOp(env, body) {
    if (body.type !== 'group' || env.seq !== 1 || !Array.isArray(body.members) || typeof body.nonce !== 'string') return null;
    if (body.members.length > 64) return null;
    if ((await groupConvId(env.author, body.nonce)) !== env.conv) return null;
    const keys = new Map();
    for (const card of body.members) {
      try { const k = await importCard(card); keys.set(k.fp, k); } catch { return null; }
    }
    const me = this.identity.fp;
    if (!keys.has(env.author) || !keys.has(me)) return null;
    const memberCards = {};
    for (const k of keys.values()) memberCards[k.fp] = { fp: k.fp, card: k.card };
    return {
      id: env.conv, kind: 'group', members: [...keys.keys()].sort(), memberCards,
      createdBy: env.author, createdAt: Date.now(), readUpTo: 0, _keys: keys,
    };
  }

  // ------------------------------------------------------------ backup

  async exportBackup(passphrase) {
    const payload = {
      identity: await exportIdentity(this.identity),
      settings: this.settings,
      contacts: [...this.contacts.values()],
      convs: [...this.convs.values()],
      ops: [...this.logs.values()].flatMap((l) => l.since({})),
      exportedAt: Date.now(),
    };
    return encryptBackup(payload, passphrase);
  }

  async importBackup(file, passphrase) {
    const data = await decryptBackup(file, passphrase);
    await importIdentity(data.identity); // validate before touching storage
    await this.store.clear();
    await this.store.put('kv', 'identity', data.identity);
    await this.store.put('kv', 'settings', data.settings || DEFAULT_SETTINGS);
    for (const c of data.contacts || []) await this.store.put('contacts', c.fp, c);
    for (const c of data.convs || []) await this.store.put('convs', c.id, c);
    for (const env of data.ops || []) await this.store.put('ops', opKey(env), env);
  }

  async wipe() {
    await this.store.clear();
  }
}

export { msgId };
