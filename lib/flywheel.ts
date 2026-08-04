import type { PostedReplyDiff, StyleCard } from './types';
import { rebuildStyleCardFromCorpus, loadStyleCard } from './corpus';
import { formatStyleCardSummary } from './style-card';

const DB_NAME = 'x_reply_copilot';
const DB_VERSION = 1;
const STORE_DIFFS = 'posted_diffs';
const REGEN_INTERVAL = 50;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_DIFFS)) {
        db.createObjectStore(STORE_DIFFS, { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

export async function storePostedDiff(diff: PostedReplyDiff): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_DIFFS, 'readwrite');
    tx.objectStore(STORE_DIFFS).add(diff);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPostedDiffCount(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DIFFS, 'readonly');
    const request = tx.objectStore(STORE_DIFFS).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllDiffs(limit = 100): Promise<PostedReplyDiff[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DIFFS, 'readonly');
    const request = tx.objectStore(STORE_DIFFS).getAll();
    request.onsuccess = () => resolve((request.result as PostedReplyDiff[]).slice(-limit));
    request.onerror = () => reject(request.error);
  });
}

export interface StyleCardRegenResult {
  regenerated: boolean;
  previous?: StyleCard;
  current: StyleCard;
  summary?: string;
}

/** Regenerate StyleCard every ~50 posted replies; return before/after when triggered. */
export async function maybeRegenerateStyleCard(handle?: string): Promise<StyleCardRegenResult> {
  const count = await getPostedDiffCount();
  const previous = await loadStyleCard();

  if (count > 0 && count % REGEN_INTERVAL === 0) {
    const current = await rebuildStyleCardFromCorpus(handle);
    return {
      regenerated: true,
      previous: previous ?? undefined,
      current,
      summary: formatStyleCardSummary(current),
    };
  }

  if (previous) {
    return { regenerated: false, current: previous };
  }

  const current = await rebuildStyleCardFromCorpus(handle);
  return { regenerated: false, current };
}

export function computeEditDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }

  return dp[m]![n]!;
}

export async function recordCreateTweet(
  postedText: string,
  inReplyToId: string | undefined,
  servedText: string | undefined,
  servedIndex: number,
): Promise<StyleCardRegenResult | null> {
  if (!postedText) return null;

  await storePostedDiff({
    tweetId: inReplyToId ?? 'unknown',
    suggestionText: servedText ?? '',
    postedText,
    suggestionIndex: servedIndex,
    timestamp: Date.now(),
  });

  return maybeRegenerateStyleCard();
}
