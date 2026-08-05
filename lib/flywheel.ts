import type { PostedReplyDiff, StyleCard, StyleCardRegenSnapshot } from './types';
import { openDb, rebuildStyleCardFromCorpus, loadStyleCard, harvestReply } from './corpus';
import { formatStyleCardSummary } from './style-card';

// F5: this module used to declare `x_reply_copilot` at version 1 with only `posted_diffs`.
// On a fresh profile, whichever module opened first won, and if this one did, `replies` and
// `style_card` were never created and no later upgrade could fire. `lib/corpus.ts` now owns
// the schema outright and this module borrows its connection.
const STORE_DIFFS = 'posted_diffs';
const REGEN_INTERVAL = 50;
export const LAST_STYLE_REGEN_KEY = 'xrcLastStyleRegen';

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
  postedDiffCount?: number;
}

async function persistRegenSnapshot(snapshot: StyleCardRegenSnapshot): Promise<void> {
  try {
    await chrome.storage.local.set({ [LAST_STYLE_REGEN_KEY]: snapshot });
  } catch {
    /* storage unavailable in non-extension harnesses */
  }
}

export async function getLastStyleRegen(): Promise<StyleCardRegenSnapshot | undefined> {
  try {
    const result = await chrome.storage.local.get(LAST_STYLE_REGEN_KEY);
    return result[LAST_STYLE_REGEN_KEY] as StyleCardRegenSnapshot | undefined;
  } catch {
    return undefined;
  }
}

/** Regenerate StyleCard every ~50 posted replies; return before/after when triggered. */
export async function maybeRegenerateStyleCard(handle?: string): Promise<StyleCardRegenResult> {
  const count = await getPostedDiffCount();
  const previous = await loadStyleCard();

  if (count > 0 && count % REGEN_INTERVAL === 0) {
    // Posted texts were inserted into `replies` by `recordCreateTweet`, so this re-derives
    // from harvest + posted voice data rather than an unchanged harvest-only corpus (F4).
    const current = await rebuildStyleCardFromCorpus(handle);
    const summary = formatStyleCardSummary(current);
    if (previous) {
      await persistRegenSnapshot({
        at: Date.now(),
        previous,
        current,
        summary,
        postedDiffCount: count,
      });
    }
    return {
      regenerated: true,
      previous: previous ?? undefined,
      current,
      summary,
      postedDiffCount: count,
    };
  }

  if (previous) {
    return { regenerated: false, current: previous, postedDiffCount: count };
  }

  const current = await rebuildStyleCardFromCorpus(handle);
  return { regenerated: false, current, postedDiffCount: count };
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

export function normalizedEditDistance(a: string, b: string): number {
  const distance = computeEditDistance(a, b);
  const denom = Math.max(a.length, b.length, 1);
  return distance / denom;
}

/**
 * CreateTweet ground truth → posted_diffs (+ edit distance) → replies corpus → StyleCard.
 * Serves `[plan todo:flywheel]` / F4.
 */
export async function recordCreateTweet(
  postedText: string,
  inReplyToId: string | undefined,
  servedText: string | undefined,
  servedIndex: number,
  handle?: string,
): Promise<StyleCardRegenResult | null> {
  if (!postedText) return null;

  const suggestionText = servedText ?? '';
  const editDistance = computeEditDistance(suggestionText, postedText);
  const normalized = normalizedEditDistance(suggestionText, postedText);

  await storePostedDiff({
    tweetId: inReplyToId ?? 'unknown',
    suggestionText,
    postedText,
    suggestionIndex: servedIndex,
    timestamp: Date.now(),
    editDistance,
    normalizedEditDistance: normalized,
  });

  // Without this, regeneration re-derives an identical card from an unchanged harvest corpus.
  await harvestReply(postedText, handle ?? 'posted');

  return maybeRegenerateStyleCard(handle);
}
