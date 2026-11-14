// Persistence. Message contents are only ever stored as the encrypted op envelopes;
// plaintext exists in memory only.

// 'inbox' holds raw (still encrypted) mailbox events fetched by the service worker in the background.
// 'blobs' holds encrypted attachment chunks, keyed "<fileId>|<index>".
export const STORES = ['kv', 'contacts', 'convs', 'ops', 'requests', 'inbox', 'blobs'];
export const DB_VERSION = 3;

export class MemoryStore {
  constructor() {
    this.data = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  }
  async get(store, key) { return structuredClone(this.data[store].get(key)); }
  async put(store, key, value) { this.data[store].set(key, structuredClone(value)); }
  async del(store, key) { this.data[store].delete(key); }
  async all(store) { return [...this.data[store].values()].map((v) => structuredClone(v)); }
  async keys(store) { return [...this.data[store].keys()]; }
  async clear() { for (const s of STORES) this.data[s].clear(); }
}

export class IDBStore {
  constructor(name = 'iwt') {
    this.name = name;
    this.db = null;
  }

  open() {
    if (this.db) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => {
        this.db = req.result;
        // Let a newer tab / the service worker upgrade the schema instead of blocking it.
        this.db.onversionchange = () => { this.db.close(); this.db = null; };
        resolve(this);
      };
      req.onerror = () => reject(req.error);
    });
  }

  _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  get(store, key) { return this._tx(store, 'readonly', (s) => s.get(key)); }
  put(store, key, value) { return this._tx(store, 'readwrite', (s) => s.put(value, key)).then(() => {}); }
  del(store, key) { return this._tx(store, 'readwrite', (s) => s.delete(key)).then(() => {}); }
  all(store) { return this._tx(store, 'readonly', (s) => s.getAll()); }
  keys(store) { return this._tx(store, 'readonly', (s) => s.getAllKeys()); }

  async clear() {
    for (const s of STORES) await this._tx(s, 'readwrite', (st) => st.clear());
  }
}
