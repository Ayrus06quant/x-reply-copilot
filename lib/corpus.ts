import { deriveStyleCard } from './style-card';
import type { StyleCard } from './types';

const DB_NAME = 'x_reply_copilot';
const DB_VERSION = 1;
const STORE_REPLIES = 'replies';
const STORE_STYLE = 'style_card';
const STORE_DIFFS = 'posted_diffs';

export interface CorpusReply {
  id?: number;
  text: string;
  handle: string;
  wordCount: number;
  harvestedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_REPLIES)) {
        const store = db.createObjectStore(STORE_REPLIES, { keyPath: 'id', autoIncrement: true });
        store.createIndex('handle', 'handle', { unique: false });
        store.createIndex('wordCount', 'wordCount', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_STYLE)) {
        db.createObjectStore(STORE_STYLE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_DIFFS)) {
        db.createObjectStore(STORE_DIFFS, { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export async function getCorpusCount(): Promise<number> {
  const replies = await getAllReplies();
  return replies.length;
}

/** Read StyleCard directly from IndexedDB — works without an active service worker. */
export async function readStyleCardDirect(): Promise<StyleCard> {
  const replies = await getAllReplies();
  const cached = await loadStyleCard();
  if (cached && cached.corpusSize === replies.length) {
    return cached;
  }
  return rebuildStyleCardFromCorpus();
}

export async function harvestReply(text: string, handle: string): Promise<boolean> {
  const normalized = text.trim();
  if (!normalized) return false;

  const existing = await getAllReplies();
  if (existing.some((r) => r.text.trim() === normalized)) return false;

  const db = await openDb();
  const entry: CorpusReply = {
    text: normalized,
    handle,
    wordCount: wordCount(normalized),
    harvestedAt: Date.now(),
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_REPLIES, 'readwrite');
    tx.objectStore(STORE_REPLIES).add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return true;
}

/** Import manually pasted replies (one per line or blank-line separated). */
export async function importManualReplies(raw: string, handle: string): Promise<number> {
  const blocks = raw
    .split(/\n\s*\n/)
    .map((b) => b.replace(/\n/g, ' ').trim())
    .filter(Boolean);
  const lines =
    blocks.length > 1
      ? blocks
      : raw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);

  let added = 0;
  for (const text of lines) {
    if (await harvestReply(text, handle)) added++;
  }
  return added;
}

export async function getAllReplies(limit = 500): Promise<CorpusReply[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REPLIES, 'readonly');
    const request = tx.objectStore(STORE_REPLIES).getAll();
    request.onsuccess = () => {
      const all = (request.result as CorpusReply[]).slice(-limit);
      resolve(all);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveStyleCard(card: StyleCard): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_STYLE, 'readwrite');
    tx.objectStore(STORE_STYLE).put({ key: 'current', card });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadStyleCard(): Promise<StyleCard | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STYLE, 'readonly');
    const request = tx.objectStore(STORE_STYLE).get('current');
    request.onsuccess = () => {
      const row = request.result as { card?: StyleCard } | undefined;
      resolve(row?.card ?? null);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Select 5 exemplars for stylistic spread — matched length, NOT topical similarity. */
export function selectExemplars(replies: CorpusReply[], targetWordCount: number, count = 5): string[] {
  if (replies.length === 0) return [];

  const sorted = [...replies].sort(
    (a, b) => Math.abs(a.wordCount - targetWordCount) - Math.abs(b.wordCount - targetWordCount),
  );

  const bucketSize = Math.max(1, Math.floor(sorted.length / count));
  const selected: string[] = [];

  for (let i = 0; i < count && i * bucketSize < sorted.length; i++) {
    const idx = i * bucketSize;
    const candidate = sorted[idx]!;
    if (!selected.includes(candidate.text)) {
      selected.push(candidate.text);
    }
  }

  while (selected.length < count && selected.length < sorted.length) {
    const next = sorted[selected.length];
    if (next && !selected.includes(next.text)) selected.push(next.text);
    else break;
  }

  return selected.slice(0, count);
}

export async function rebuildStyleCardFromCorpus(handle?: string): Promise<StyleCard> {
  const replies = await getAllReplies();
  const texts = replies.map((r) => r.text);
  const card = deriveStyleCard(texts, handle ?? replies[0]?.handle);
  await saveStyleCard(card);
  return card;
}

export async function getExemplarsForCompose(targetWordCount: number): Promise<string[]> {
  const replies = await getAllReplies();
  return selectExemplars(replies, targetWordCount, 5);
}

async function clearStore(storeName: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Wipe harvested replies, StyleCard cache, and posted-diff flywheel data. */
export async function clearVoiceData(): Promise<StyleCard> {
  await clearStore(STORE_REPLIES);
  await clearStore(STORE_DIFFS);
  await clearStore(STORE_STYLE);
  return rebuildStyleCardFromCorpus();
}
