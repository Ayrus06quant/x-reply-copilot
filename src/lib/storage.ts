const DB_NAME = 'x-reply-copilot';
const DB_VERSION = 1;

export interface IDBStores {
  corpus: { id: string; text: string; wordCount: number; createdAt: number; isOwnReply: boolean };
  diffs: {
    id: string;
    tweetId: string;
    suggestionId?: string;
    suggestionText?: string;
    postedText: string;
    diffRatio: number;
    timestamp: number;
  };
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (ev) => {
      const db = (ev.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('corpus')) {
        db.createObjectStore('corpus', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('diffs')) {
        db.createObjectStore('diffs', { keyPath: 'id' });
      }
    };
  });
}

async function withStore<T>(
  storeName: 'corpus' | 'diffs',
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = fn(store);
    if (result) {
      result.onsuccess = () => resolve(result.result as T);
      result.onerror = () => reject(result.error);
    } else {
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    }
  });
}

export async function addCorpusEntry(entry: IDBStores['corpus']): Promise<void> {
  await withStore('corpus', 'readwrite', (s) => s.put(entry));
}

export async function getAllCorpus(): Promise<IDBStores['corpus'][]> {
  return (await withStore('corpus', 'readonly', (s) => s.getAll())) ?? [];
}

export async function addPostedDiff(diff: IDBStores['diffs']): Promise<void> {
  await withStore('diffs', 'readwrite', (s) => s.put(diff));
}

export async function getAllDiffs(): Promise<IDBStores['diffs'][]> {
  return (await withStore('diffs', 'readonly', (s) => s.getAll())) ?? [];
}

export async function getCorpusCount(): Promise<number> {
  const all = await getAllCorpus();
  return all.filter((e) => e.isOwnReply).length;
}

/** IndexedDB in service worker context */
export { openDB };
