import type { StyleCard } from './types';
import { DEFAULT_STYLE_CARD } from './prompts';

const CONTRACTIONS = /\b(i'm|you're|it's|that's|don't|can't|won't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|wouldn't|couldn't|shouldn't|i've|you've|we've|they've|i'll|you'll|we'll|they'll|i'd|you'd|we'd|they'd|gonna|wanna|gotta|tbh|imo|idk|ngl)\b/gi;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 14;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx] ?? sorted[0]!;
}

function extractOpeners(texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const match = text.trim().match(/^(\S+\s*\S?)/);
    if (match) {
      const opener = match[1]!.toLowerCase().slice(0, 20);
      counts.set(opener, (counts.get(opener) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([o]) => o);
}

function extractSignaturePhrases(texts: string[]): string[] {
  const phrases = new Map<string, number>();
  for (const text of texts) {
    const lower = text.toLowerCase();
    for (const phrase of ['tbh', 'imo', 'ngl', 'fwiw', 'idk', 'lowkey', 'honestly']) {
      if (lower.includes(phrase)) {
        phrases.set(phrase, (phrases.get(phrase) ?? 0) + 1);
      }
    }
  }
  return [...phrases.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([p]) => p);
}

/** Derive StyleCard from harvested reply corpus. */
export function deriveStyleCard(replies: string[], handle?: string): StyleCard {
  if (replies.length === 0) {
    return { ...DEFAULT_STYLE_CARD, sampleHandle: handle, updatedAt: Date.now() };
  }

  const wordCounts = replies.map(wordCount);
  const totalWords = replies.reduce((sum, t) => sum + wordCount(t), 0);
  const totalChars = replies.reduce((sum, t) => sum + t.length, 0);

  let contractionHits = 0;
  let emojiHits = 0;
  let exclamationHits = 0;
  let lowercaseOpeners = 0;

  for (const text of replies) {
    const contractions = text.match(CONTRACTIONS);
    if (contractions) contractionHits += contractions.length;

    const emojis = text.match(EMOJI_RE);
    if (emojis) emojiHits += emojis.length;

    if (text.includes('!')) exclamationHits++;

    const firstChar = text.trim()[0];
    if (firstChar && firstChar === firstChar.toLowerCase() && /[a-z]/.test(firstChar)) {
      lowercaseOpeners++;
    }
  }

  return {
    medianWordCount: percentile(wordCounts, 0.5),
    wordCountP25: percentile(wordCounts, 0.25),
    wordCountP75: percentile(wordCounts, 0.75),
    contractionRate: totalWords > 0 ? contractionHits / totalWords : 0.35,
    lowercaseOpenerRate: replies.length > 0 ? lowercaseOpeners / replies.length : 0.5,
    emojiRate: totalChars > 0 ? emojiHits / replies.length : 0.05,
    exclamationRate: replies.length > 0 ? exclamationHits / replies.length : 0.05,
    openers: extractOpeners(replies),
    closers: [],
    signaturePhrases: extractSignaturePhrases(replies),
    bannedPatterns: DEFAULT_STYLE_CARD.bannedPatterns,
    sampleHandle: handle,
    corpusSize: replies.length,
    updatedAt: Date.now(),
  };
}

export function formatStyleCardSummary(card: StyleCard): string {
  const lines = [
    `You average ${card.medianWordCount} words per reply (${card.wordCountP25}–${card.wordCountP75} range).`,
    `Lowercase openers: ${(card.lowercaseOpenerRate * 100).toFixed(0)}% of the time.`,
    `Emoji rate: ~${(card.emojiRate * 100).toFixed(1)}% per reply.`,
    card.signaturePhrases.length
      ? `Signature phrases: ${card.signaturePhrases.map((p) => `"${p}"`).join(', ')}.`
      : 'No strong signature phrases detected yet.',
    `Corpus: ${card.corpusSize} replies harvested.`,
  ];
  return lines.join('\n');
}
