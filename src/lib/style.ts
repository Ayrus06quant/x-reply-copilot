import type { StyleCard } from '../types/style';
import { DEFAULT_STYLE_CARD } from '../types/style';
import type { IDBStores } from './storage';
import { getAllCorpus } from './storage';

const CONTRACTIONS = /\b(don't|won't|can't|it's|i'm|you're|we're|they're|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|wouldn't|couldn't|shouldn't|i've|you've|we've|they've|i'll|you'll|we'll|they'll|i'd|you'd|we'd|they'd|gonna|wanna|gotta|kinda|sorta|tbh|imo|idk|ngl)\b/gi;

function median(nums: number[]): number {
  if (!nums.length) return 14;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(nums: number[], p: number): number {
  if (!nums.length) return 22;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function countEmojis(text: string): number {
  const matches = text.match(/\p{Extended_Pictographic}/gu);
  return matches?.length ?? 0;
}

function extractOpeners(texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const first = t.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (first.length >= 2 && first.length <= 12) {
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

function extractSignaturePhrases(texts: string[]): string[] {
  const phrases = new Map<string, number>();
  for (const t of texts) {
    const words = t.toLowerCase().split(/\s+/);
    for (let i = 0; i < words.length - 1; i++) {
      const bi = `${words[i]} ${words[i + 1]}`;
      if (bi.length >= 5) phrases.set(bi, (phrases.get(bi) ?? 0) + 1);
    }
  }
  return [...phrases.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([p]) => p);
}

export async function deriveStyleCard(): Promise<StyleCard> {
  const corpus = await getAllCorpus();
  const own = corpus.filter((e) => e.isOwnReply);
  if (own.length < 3) return { ...DEFAULT_STYLE_CARD, sampleCount: own.length };

  const wordCounts = own.map((e) => e.wordCount);
  const emojiCounts = own.map((e) => countEmojis(e.text));
  const totalWords = wordCounts.reduce((a, b) => a + b, 0);
  const emojiRate = totalWords > 0 ? emojiCounts.reduce((a, b) => a + b, 0) / totalWords : 0.05;

  const lowercaseOpeners = own.filter((e) => {
    const first = e.text.trim()[0];
    return first && first === first.toLowerCase() && first !== first.toUpperCase();
  }).length;

  const withContractions = own.filter((e) => CONTRACTIONS.test(e.text)).length;
  const texts = own.map((e) => e.text);

  const allLower = own.filter((e) => e.text === e.text.toLowerCase()).length;
  const capStyle: StyleCard['capitalizationStyle'] =
    allLower / own.length > 0.6 ? 'lowercase' : 'mixed';

  return {
    medianWordCount: Math.round(median(wordCounts)),
    p75WordCount: Math.round(percentile(wordCounts, 75)),
    emojiRate: Math.min(emojiRate, 0.3),
    lowercaseOpenerRate: lowercaseOpeners / own.length,
    contractionRate: withContractions / own.length,
    openers: extractOpeners(texts),
    signaturePhrases: extractSignaturePhrases(texts),
    bannedPatterns: DEFAULT_STYLE_CARD.bannedPatterns,
    capitalizationStyle: capStyle,
    sampleCount: own.length,
    updatedAt: Date.now(),
  };
}

export function selectExemplars(
  corpus: IDBStores['corpus'][],
  targetLength: number,
  count = 5,
): string[] {
  const own = corpus.filter((e) => e.isOwnReply);
  if (own.length === 0) return [];

  const scored = own.map((e) => ({
    text: e.text,
    lengthDist: Math.abs(e.wordCount - targetLength),
    styleSpread: e.wordCount,
  }));

  scored.sort((a, b) => a.lengthDist - b.lengthDist);

  const selected: string[] = [];
  const used = new Set<number>();

  for (const candidate of scored) {
    if (selected.length >= count) break;
    const idx = own.findIndex((o) => o.text === candidate.text);
    if (used.has(idx)) continue;

    const tooSimilar = selected.some((s) => {
      const overlap = s.split(' ').filter((w) => candidate.text.includes(w)).length;
      return overlap / Math.max(s.split(' ').length, 1) > 0.7;
    });
    if (tooSimilar && selected.length >= 2) continue;

    selected.push(candidate.text);
    used.add(idx);
  }

  while (selected.length < count && selected.length < own.length) {
    const next = scored.find((s) => !selected.includes(s.text));
    if (!next) break;
    selected.push(next.text);
  }

  return selected.slice(0, count);
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export async function maybeRegenerateStyleCard(
  postedCount: number,
): Promise<StyleCard | null> {
  if (postedCount > 0 && postedCount % 50 === 0) {
    return deriveStyleCard();
  }
  return null;
}
