/**
 * The vault (P1-09, ADR-010, S-11): one IndexedDB database in the extension origin, which content
 * scripts cannot open. Writes use Chrome's default `relaxed` durability (S-11: 10 of 10 commits
 * survived a SIGKILL). The connection is opened once per wake and re-opened after a failure.
 */
import type { VaultPort } from './ports.js';

const DB_NAME = 'vault';
const DB_VERSION = 1;
const STORE = 'kv';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function open(factory: IDBFactory, onLost: () => void): Promise<IDBDatabase> {
  const req = factory.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
  };
  req.onblocked = () => {
    onLost();
  };
  return request(req).then((db) => {
    // Chrome may close the connection (storage cleared) or a newer version may need it: drop the
    // cached handle so the next call re-opens instead of failing with InvalidStateError (review).
    db.onclose = onLost;
    db.onversionchange = () => {
      db.close();
      onLost();
    };
    return db;
  });
}

function commit(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

export function createVaultPort(factory: IDBFactory): VaultPort {
  let db: Promise<IDBDatabase> | null = null;
  const connect = (): Promise<IDBDatabase> => {
    db ??= open(factory, () => {
      db = null;
    }).catch((error: unknown) => {
      db = null;
      throw error;
    });
    return db;
  };
  return {
    get: async (key) => {
      const store = (await connect()).transaction(STORE, 'readonly').objectStore(STORE);
      return request(store.get(key)) as Promise<unknown>;
    },
    set: async (key, value) => {
      const tx = (await connect()).transaction(STORE, 'readwrite', { durability: 'relaxed' });
      tx.objectStore(STORE).put(value, key);
      await commit(tx);
    },
    remove: async (key) => {
      const tx = (await connect()).transaction(STORE, 'readwrite', { durability: 'relaxed' });
      tx.objectStore(STORE).delete(key);
      await commit(tx);
    },
  };
}
