// The engine owns identity, contacts, conversations and the CRDT op logs.
// It knows nothing about networking: the network layer feeds it ops via ingest()
// and asks it which ops a peer is missing.

import {
  generateIdentity, importIdentity, exportIdentity, importCard, sealOp, openOp, verifyOp,
  isWellFormedOp, encryptBackup, decryptBackup,
} from './crypto.js';
import { OpLog, ConversationView, msgId, streamOf, PINNED_TYPES } from './crdt.js';
import { utf8, hex, sha256, b64u, randomBytes } from './encoding.js';

const newDeviceId = () => hex(randomBytes(8));
const newInvite = () => ({ token: b64u(randomBytes(16)), at: Date.now() });
const INVITE_RE = /^[A-Za-z0-9_-]{16,43}$/;

export const DEFAULT_SETTINGS = {
  relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom'],
  iceServers: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  // Relays YOU run or trust to hold encrypted messages for you while you're offline (max 7 days).
  // Never public relays: those only ever see ephemeral signalling.
  mailboxRelays: [],
  notifications: false,
};

const MAX_MAILBOXES = 4;
const DAY_MS = 86400000;
// Retention: how long messages live before every member deletes them. Direct chats use the
// protocol default; groups fix theirs in the signed creation op so all members agree.
export const DEFAULT_RETENTION_DAYS = 365;
export const RETENTION_CHOICES = [7, 30, 90, 365, 730];
export const clampRetention = (d) => (Number.isSafeInteger(d) && d >= 1 && d <= 3650 ? d : DEFAULT_RETENTION_DAYS);
const MAX_FUTURE_MS = DAY_MS; // tolerated clock skew for op timestamps
export function cleanRelayList(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((u) => typeof u === 'string' && /^wss?:\/\/[^\s]{1,200}$/.test(u)))].slice(0, MAX_MAILBOXES);
}

export const opKey = (env) => env.conv + '|' + env.author + '|' + env.dev + '|' + env.seq;

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
    this.mailboxes = new Map(); // fp -> [relay url]: where that peer collects offline mail
    this.outbox = new Map();    // fp -> Set<opKey>: our ops still to be mailed to that peer
    this.mailSince = 0;         // unix seconds: newest mailbox event we've processed
    this.device = null;         // random id of this installation; never copied to other devices
    this.lastTs = 0;            // this device's op timestamps never decrease (expiry watermarks rely on it)
    this.removed = {};          // fp -> ms: contact removals, merged across our own devices
    this.nameAt = 0;            // when our display name last changed (merged across our devices)
    this.invite = null;         // {token, at}: secret in our contact link; whoever presents it is auto-accepted
    this.now = () => Date.now(); // overridable clock (tests)
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
    this.device = await this._deviceId();
    this.removed = (await this.store.get('kv', 'removed')) || {};
    this.nameAt = (await this.store.get('kv', 'nameAt')) || 0;
    this.invite = await this._loadInvite();
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.store.get('kv', 'settings')) || {}) };
    this._addKey({ fp: this.identity.fp, name: this.identity.name, signKey: this.identity.signPub, dhKey: this.identity.dhPub, card: this.identity.card() });

    for (const c of await this.store.all('contacts')) {
      try {
        this._addKey(await importCard(c.card));
        this.contacts.set(c.fp, c);
      } catch (e) { console.warn('bad stored contact', e); }
    }
    for (const r of await this.store.all('requests')) this.requests.set(r.fp, r);
    for (const [fp, list] of Object.entries((await this.store.get('kv', 'mailboxes')) || {})) this.mailboxes.set(fp, list);
    for (const [fp, keys] of Object.entries((await this.store.get('kv', 'outbox')) || {})) this.outbox.set(fp, new Set(keys));
    this.mailSince = (await this.store.get('kv', 'mailSince')) || 0;
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
        if (env.author === this.identity.fp && env.dev === this.device && env.ts > this.lastTs) this.lastTs = env.ts;
      } catch (e) { console.warn('stored op unreadable', e); }
    }
    await this._prune();
    await this._saveBackgroundConfig();
    return true;
  }

  /** Plain, non-secret settings the service worker needs for background mailbox checks. */
  async _saveBackgroundConfig() {
    await this.store.put('kv', 'bg', {
      fp: this.identity.fp,
      mailboxRelays: this.settings.mailboxRelays || [],
      notifications: !!this.settings.notifications,
      mailSince: this.mailSince,
    });
  }

  /** Each installation gets its own device id (kept out of backups and device links). */
  async _deviceId() {
    let d = await this.store.get('kv', 'device');
    if (!d) { d = newDeviceId(); await this.store.put('kv', 'device', d); }
    return d;
  }

  async _loadInvite() {
    let inv = await this.store.get('kv', 'invite');
    if (!inv) { inv = newInvite(); await this.store.put('kv', 'invite', inv); }
    return inv;
  }

  /** Invalidate every contact link shared so far; old links fall back to contact requests. */
  async resetInvite() {
    this.invite = newInvite();
    await this.store.put('kv', 'invite', this.invite);
    this._emit('change', { what: 'invite' });
  }

  checkInvite(token) {
    return typeof token === 'string' && !!this.invite && token === this.invite.token;
  }

  async createIdentity(name) {
    this.identity = await generateIdentity(name.trim().slice(0, 64) || 'Anonymous');
    this.device = await this._deviceId();
    this.invite = await this._loadInvite();
    await this.store.put('kv', 'identity', await exportIdentity(this.identity));
    await this.store.put('kv', 'settings', this.settings);
    this._addKey({ fp: this.identity.fp, name: this.identity.name, signKey: this.identity.signPub, dhKey: this.identity.dhPub, card: this.identity.card() });
    await this._saveBackgroundConfig();
    return this.identity;
  }

  async setName(name, at = Date.now()) {
    this.identity.name = name.trim().slice(0, 64) || this.identity.name;
    this.nameAt = at;
    await this.store.put('kv', 'nameAt', at);
    await this.store.put('kv', 'identity', await exportIdentity(this.identity));
    this.keyring.get(this.identity.fp).name = this.identity.name;
    this._emit('change', { what: 'identity' });
  }

  async saveSettings(patch) {
    if (patch.mailboxRelays) patch = { ...patch, mailboxRelays: cleanRelayList(patch.mailboxRelays) };
    this.settings = { ...this.settings, ...patch };
    await this.store.put('kv', 'settings', this.settings);
    await this._saveBackgroundConfig();
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

  /**
   * What a contact link carries: our public card, where we can be mailed, and our invite
   * token. Presenting the token proves the person got the link from us, so we accept them
   * without a request.
   */
  myLinkPayload() {
    const m = this.settings.mailboxRelays || [];
    return { ...this.identity.card(), ...(m.length ? { m } : {}), i: this.invite.token };
  }

  async addContact(card, { addedAt = Date.now(), nick, nickAt, via } = {}) {
    const k = await importCard(card);
    if (k.fp === this.identity.fp) throw new Error("That's your own card");
    if (Array.isArray(card.m)) await this.setPeerMailboxes(k.fp, card.m);
    return this._serial(async () => {
      this._addKey(k);
      const existing = this.contacts.get(k.fp);
      const c = {
        fp: k.fp, card: k.card, addedAt: existing?.addedAt || addedAt,
        nick: existing?.nick || nick || '', nickAt: existing?.nickAt || nickAt || 0,
        // Their invite token, presented until we've connected once so they auto-accept us.
        invite: existing?.invite || (typeof card.i === 'string' && INVITE_RE.test(card.i) ? card.i : undefined),
      };
      if (this.removed[k.fp]) { delete this.removed[k.fp]; await this.store.put('kv', 'removed', this.removed); }
      this.contacts.set(k.fp, c);
      await this.store.put('contacts', k.fp, c);
      if (this.requests.delete(k.fp)) await this.store.del('requests', k.fp);
      await this._ensureDirectConv(k.fp);
      this._emit('change', { what: 'contacts', fp: k.fp, added: !existing, via });
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

  // ------------------------------------------------------------ offline mail

  /** Record the mailbox relays a peer told us (over an authenticated channel or their link). */
  async setPeerMailboxes(fp, list) {
    const clean = cleanRelayList(list);
    if ((this.mailboxes.get(fp) || []).join() === clean.join()) return;
    if (clean.length) this.mailboxes.set(fp, clean); else this.mailboxes.delete(fp);
    await this.store.put('kv', 'mailboxes', Object.fromEntries(this.mailboxes));
  }

  async queueMail(fp, env) {
    if (!this.mailboxes.get(fp)?.length) return false;
    let set = this.outbox.get(fp);
    if (!set) { set = new Set(); this.outbox.set(fp, set); }
    set.add(opKey(env));
    await this._saveOutbox();
    return true;
  }

  /** Ops waiting to be mailed to fp (oldest first). */
  pendingMail(fp) {
    const out = [];
    for (const key of this.outbox.get(fp) || []) {
      const [conv, author, dev, seq] = key.split('|');
      const env = this.logs.get(conv)?.get(author + '/' + dev, Number(seq));
      if (env) out.push(env);
    }
    return out.sort((a, b) => a.lamport - b.lamport);
  }

  async clearMail(fp, keys) {
    const set = this.outbox.get(fp);
    if (!set) return;
    if (keys) for (const k of keys) set.delete(k); else set.clear();
    if (!set.size) this.outbox.delete(fp);
    await this._saveOutbox();
  }

  _saveOutbox() {
    return this.store.put('kv', 'outbox', Object.fromEntries([...this.outbox].map(([fp, s]) => [fp, [...s]])));
  }

  async setMailSince(t) {
    if (t <= this.mailSince) return;
    this.mailSince = t;
    await this.store.put('kv', 'mailSince', t);
    await this._saveBackgroundConfig();
  }

  /** They know us now (we connected), so stop presenting their invite token. */
  async clearInvite(fp) {
    const c = this.contacts.get(fp);
    if (!c?.invite) return;
    delete c.invite;
    await this.store.put('contacts', fp, c);
  }

  async setNick(fp, nick, at = Date.now()) {
    const c = this.contacts.get(fp);
    if (!c) return;
    c.nick = nick.trim().slice(0, 64);
    c.nickAt = at;
    await this.store.put('contacts', fp, c);
    this._emit('change', { what: 'contacts' });
  }

  async removeContact(fp, at = Date.now()) {
    if (!this.contacts.delete(fp)) return;
    await this.store.del('contacts', fp);
    this.removed[fp] = at;
    await this.store.put('kv', 'removed', this.removed);
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

  retentionDays(conv) {
    return conv.kind === 'group' ? clampRetention(conv.retentionDays) : DEFAULT_RETENTION_DAYS;
  }

  _cutoff(conv) {
    return this.now() - this.retentionDays(conv) * DAY_MS;
  }

  /** Delete expired ops everywhere in our replica. Safe to call any time (runs hourly). */
  prune() {
    return this._serial(() => this._prune());
  }

  async _prune() {
    let changed = false;
    for (const conv of this.convs.values()) {
      const log = this.logs.get(conv.id);
      const view = this.views.get(conv.id);
      for (const wm of log.expiredHeads(this._cutoff(conv))) {
        const dropped = log.advanceFloor(wm);
        for (const e of dropped) await this.store.del('ops', opKey(e));
        view.remove(log.pinned.has(msgId(wm)) ? dropped : [...dropped, wm]);
        changed = true;
      }
    }
    if (changed) this._emit('change', { what: 'expired' });
    return changed;
  }

  async createGroup(name, memberFps, retentionDays = DEFAULT_RETENTION_DAYS) {
    retentionDays = clampRetention(retentionDays);
    const members = [...new Set([this.identity.fp, ...memberFps])];
    if (members.length < 2) throw new Error('A group needs at least one other member');
    for (const m of members) if (!this.keyring.has(m)) throw new Error('Unknown member ' + m);
    return this._serial(async () => {
      const nonce = b64u(randomBytes(16));
      const id = await groupConvId(this.identity.fp, nonce);
      const memberCards = {};
      for (const m of members) memberCards[m] = { fp: m, card: this.keyring.get(m).card };
      const conv = { id, kind: 'group', members: members.sort(), memberCards, createdBy: this.identity.fp, createdAt: Date.now(), readUpTo: 0, retentionDays };
      this._registerConv(conv);
      await this.store.put('convs', id, conv);
      await this._send(id, {
        type: 'group', name: name.trim().slice(0, 80) || 'Group', nonce,
        members: members.map((m) => memberCards[m].card), retentionDays, ts: Date.now(),
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
    this.lastTs = Math.max(this.now(), this.lastTs);
    const env = await sealOp(this.identity, recipients, {
      conv: convId, dev: this.device, seq: log.nextSeq(this.identity.fp + '/' + this.device), lamport: this.clock + 1, ts: this.lastTs,
    }, body);
    await this.store.put('ops', opKey(env), env);
    this._applyOp(env, body);
    this._emit('op', { env, body, conv: convId, local: true });
    return env;
  }

  _applyOp(env, body) {
    const log = this.logs.get(env.conv);
    if (!log.add(env, PINNED_TYPES.has(body.type))) return false;
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
    if (conv && this.logs.get(env.conv).has(streamOf(env), env.seq)) return { added: false, reason: 'duplicate' };
    if (typeof env.keys[me] !== 'string') return { added: false, reason: 'not addressed to us' };
    if (env.ts > this.now() + MAX_FUTURE_MS) return { added: false, reason: 'timestamp in the future' };

    let body;
    try { body = await openOp(this.identity, env); } catch { return { added: false, reason: 'decrypt failed' }; }
    if (!body || typeof body.type !== 'string') return { added: false, reason: 'bad body' };

    let newConv = null;
    if (!conv) {
      if (env.conv.startsWith('d:')) {
        // The other party is the author — or, for an op from one of our own other devices,
        // whichever contact the conversation id belongs to.
        let other = env.author === me ? null : env.author;
        if (!other) {
          for (const fp of this.keyring.keys()) {
            if (fp !== me && (await directConvId(me, fp)) === env.conv) { other = fp; break; }
          }
        }
        if (!other || !this.keyring.has(other)) return { added: false, reason: 'unknown author' };
        if ((await directConvId(me, other)) !== env.conv) return { added: false, reason: 'bad direct id' };
        const k = this.keyring.get(other);
        newConv = {
          id: env.conv, kind: 'direct', members: [me, other].sort(),
          memberCards: { [other]: { fp: other, card: k.card } }, createdAt: Date.now(), readUpTo: 0,
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

    const pinned = PINNED_TYPES.has(body.type);
    if (!pinned && conv && env.seq <= this.logs.get(conv.id).floor(streamOf(env))) return { added: false, reason: 'expired' };
    // An expired op is still useful: it is a signed watermark that lets us skip that author's older history.
    const expired = !pinned && env.ts <= this._cutoff(c);

    if (newConv) {
      const keys = newConv._keys;
      delete newConv._keys;
      if (keys) for (const k of keys.values()) if (!this.keyring.has(k.fp)) this._addKey(k);
      this._registerConv(newConv);
      await this.store.put('convs', newConv.id, newConv);
    }
    await this.store.put('ops', opKey(env), env);
    this._applyOp(env, body);
    if (expired) {
      await this._prune();
      return { added: true, expired: true };
    }
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
      retentionDays: clampRetention(body.retentionDays),
    };
  }

  // ------------------------------------------------------------ backup

  /** Everything another device of ours needs (backups and device linking). Secret! */
  async exportState() {
    return {
      v: 1,
      identity: await exportIdentity(this.identity),
      settings: this.settings,
      contacts: [...this.contacts.values()],
      requests: [...this.requests.values()],
      removed: this.removed,
      nameAt: this.nameAt,
      convs: [...this.convs.values()],
      ops: [...this.logs.values()].flatMap((l) => l.since({})),
      mailboxes: Object.fromEntries(this.mailboxes),
      mailSince: this.mailSince,
      invite: this.invite,
      exportedAt: Date.now(),
    };
  }

  /**
   * Replace local storage with exported state. The device id is NOT imported: this
   * installation keeps (or gets) its own, so its ops form a separate CRDT stream.
   */
  async importState(data) {
    await importIdentity(data.identity); // validate before touching storage
    const device = await this.store.get('kv', 'device');
    await this.store.clear();
    await this.store.put('kv', 'device', device || newDeviceId());
    await this.store.put('kv', 'identity', data.identity);
    await this.store.put('kv', 'settings', data.settings || DEFAULT_SETTINGS);
    for (const c of data.contacts || []) await this.store.put('contacts', c.fp, c);
    for (const r of data.requests || []) await this.store.put('requests', r.fp, r);
    for (const c of data.convs || []) await this.store.put('convs', c.id, c);
    for (const env of data.ops || []) await this.store.put('ops', opKey(env), env);
    if (data.mailboxes) await this.store.put('kv', 'mailboxes', data.mailboxes);
    if (data.removed) await this.store.put('kv', 'removed', data.removed);
    if (data.nameAt) await this.store.put('kv', 'nameAt', data.nameAt);
    if (data.mailSince) await this.store.put('kv', 'mailSince', data.mailSince);
    if (data.invite) await this.store.put('kv', 'invite', data.invite);
  }

  async exportBackup(passphrase) {
    return encryptBackup(await this.exportState(), passphrase);
  }

  async importBackup(file, passphrase) {
    await this.importState(await decryptBackup(file, passphrase));
  }

  // ------------------------------------------------------------ our own other devices

  /** Address book + profile, exchanged between our own devices on every connection. */
  ownDeviceSummary() {
    return {
      name: this.identity.name, nameAt: this.nameAt,
      contacts: [...this.contacts.values()].map(({ card, nick, nickAt, addedAt }) => ({ card, nick, nickAt, addedAt })),
      removed: this.removed,
      mailboxes: Object.fromEntries(this.mailboxes),
      invite: this.invite, // links shared from any of our devices work on all of them
    };
  }

  /** Merge another of our devices' summary. Add-wins per (addedAt vs removal time); LWW for names. */
  async mergeOwnDevice(sum) {
    if (!sum || typeof sum !== 'object') return;
    if (typeof sum.name === 'string' && Number(sum.nameAt) > this.nameAt) await this.setName(sum.name, Number(sum.nameAt));
    if (sum.invite && INVITE_RE.test(sum.invite.token) && Number(sum.invite.at) > (this.invite?.at || 0)) {
      this.invite = { token: sum.invite.token, at: Number(sum.invite.at) };
      await this.store.put('kv', 'invite', this.invite);
    }
    for (const [fp, at] of Object.entries(sum.removed || {})) {
      const c = this.contacts.get(fp);
      if (c && Number(at) > (c.addedAt || 0)) await this.removeContact(fp, Number(at));
      else if (!c && Number(at) > (this.removed[fp] || 0)) { this.removed[fp] = Number(at); await this.store.put('kv', 'removed', this.removed); }
    }
    for (const r of (Array.isArray(sum.contacts) ? sum.contacts : []).slice(0, 5000)) {
      let k;
      try { k = await importCard(r.card); } catch { continue; }
      if (k.fp === this.identity.fp) continue;
      const addedAt = Number(r.addedAt) || 0;
      if ((this.removed[k.fp] || 0) >= addedAt) continue;
      const mine = this.contacts.get(k.fp);
      if (!mine) await this.addContact(k.card, { addedAt, nick: String(r.nick || ''), nickAt: Number(r.nickAt) || 0 });
      else if (Number(r.nickAt) > (mine.nickAt || 0)) await this.setNick(k.fp, String(r.nick || ''), Number(r.nickAt));
    }
    for (const [fp, list] of Object.entries(sum.mailboxes || {})) {
      if (!this.mailboxes.has(fp)) await this.setPeerMailboxes(fp, list);
    }
  }

  async wipe() {
    await this.store.clear();
  }
}

export { msgId };
