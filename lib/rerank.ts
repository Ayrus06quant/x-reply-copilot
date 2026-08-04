import type { StyleCard, Suggestion, VerbalizedCandidate } from './types';

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const URL_RE = /https?:\/\/\S+/gi;
const HANDLE_RE = /@\w+/g;
// `.test()` on a /g regex advances lastIndex, so consecutive calls alternate. Keep this one global-free.
const HASHTAG_TEST_RE = /#\w+/;

const ANTHITHESIS_PATTERNS = [
  /\bnot\s+\w+[,\s]+but\b/i,
  /\bit'?s not about\b/i,
  /\bnot just\b/i,
];

const BANNED_WORDS = [
  'delve',
  'underscore',
  'meticulous',
  'commendable',
  'tapestry',
  'intricate',
];

/** Character trigram frequency vector for cosine similarity. */
function trigramVector(text: string): Map<string, number> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const vec = new Map<string, number>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    const tri = normalized.slice(i, i + 3);
    vec.set(tri, (vec.get(tri) ?? 0) + 1);
  }
  return vec;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [, v] of a) normA += v * v;
  for (const [, v] of b) normB += v * v;

  for (const [k, vA] of a) {
    const vB = b.get(k) ?? 0;
    dot += vA * vB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Build author centroid from corpus texts. */
export function buildAuthorCentroid(corpusTexts: string[]): Map<string, number> {
  const combined = new Map<string, number>();
  for (const text of corpusTexts) {
    const vec = trigramVector(text);
    for (const [k, v] of vec) {
      combined.set(k, (combined.get(k) ?? 0) + v);
    }
  }
  return combined;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function emojiCount(text: string): number {
  return (text.match(EMOJI_RE) ?? []).length;
}

export interface GateContext {
  styleCard: StyleCard;
  allowedHandles: string[];
  corpusTexts: string[];
}

/** Deterministic output gate — strips/fails candidates violating style constraints. */
export function passesOutputGate(text: string, ctx: GateContext): { pass: boolean; reason?: string; cleaned?: string } {
  let cleaned = text.replace(URL_RE, '').trim();

  if (HASHTAG_TEST_RE.test(cleaned)) {
    return { pass: false, reason: 'hashtag' };
  }

  const handles = cleaned.match(HANDLE_RE) ?? [];
  for (const h of handles) {
    const bare = h.slice(1).toLowerCase();
    if (!ctx.allowedHandles.some((a) => a.toLowerCase() === bare)) {
      return { pass: false, reason: 'unknown_handle' };
    }
  }

  const wc = wordCount(cleaned);
  if (wc < Math.max(3, ctx.styleCard.wordCountP25 - 5)) {
    return { pass: false, reason: 'too_short' };
  }
  if (wc > ctx.styleCard.wordCountP75 + 15) {
    return { pass: false, reason: 'too_long' };
  }

  const emojiRate = emojiCount(cleaned) / Math.max(wc, 1);
  if (emojiRate > ctx.styleCard.emojiRate + 0.15) {
    return { pass: false, reason: 'emoji_rate' };
  }

  const lower = cleaned.toLowerCase();
  for (const word of BANNED_WORDS) {
    if (lower.includes(word)) return { pass: false, reason: `banned:${word}` };
  }
  for (const pattern of ctx.styleCard.bannedPatterns) {
    if (lower.includes(pattern.toLowerCase())) return { pass: false, reason: 'antithesis' };
  }
  for (const pat of ANTHITHESIS_PATTERNS) {
    if (pat.test(cleaned)) return { pass: false, reason: 'antithesis_pattern' };
  }

  return { pass: true, cleaned };
}

/** Rerank candidates using trigram cosine vs author centroid + length match. */
export function rerankCandidates(
  candidates: VerbalizedCandidate[],
  ctx: GateContext,
  topK = 3,
): Suggestion[] {
  const centroid = buildAuthorCentroid(ctx.corpusTexts);

  const scored: Array<{ candidate: VerbalizedCandidate; score: number; cleaned: string }> = [];

  for (const candidate of candidates) {
    const gate = passesOutputGate(candidate.text, ctx);
    if (!gate.pass || !gate.cleaned) continue;

    const vec = trigramVector(gate.cleaned);
    const styleScore = cosineSimilarity(vec, centroid);
    const lengthPenalty =
      1 - Math.abs(wordCount(gate.cleaned) - ctx.styleCard.medianWordCount) / (ctx.styleCard.medianWordCount + 5);
    const probBonus = candidate.probability * 0.2;
    const score = styleScore * 0.6 + lengthPenalty * 0.2 + probBonus;

    scored.push({ candidate, score, cleaned: gate.cleaned });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map((s, i) => ({
    text: s.cleaned,
    intent: s.candidate.intent,
    probability: s.candidate.probability,
    rank: i + 1,
  }));
}

/** Human-readable tally of why every candidate was rejected, for the error surfaced to the user. */
export function summarizeGateFailures(candidates: VerbalizedCandidate[], ctx: GateContext): string {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const gate = passesOutputGate(c.text, ctx);
    if (gate.pass) continue;
    const reason = gate.reason ?? 'unknown';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => (count > 1 ? `${reason} ×${count}` : reason))
    .join(', ');
}

/** Fallback when corpus is empty — gate + sort by probability only. */
export function rerankWithoutCorpus(candidates: VerbalizedCandidate[], ctx: GateContext, topK = 3): Suggestion[] {
  const passed: Suggestion[] = [];
  for (const c of candidates.sort((a, b) => b.probability - a.probability)) {
    const gate = passesOutputGate(c.text, ctx);
    if (gate.pass && gate.cleaned) {
      passed.push({ text: gate.cleaned, intent: c.intent, probability: c.probability, rank: passed.length + 1 });
    }
    if (passed.length >= topK) break;
  }
  return passed;
}
