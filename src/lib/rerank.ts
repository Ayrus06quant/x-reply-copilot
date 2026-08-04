import type { StyleCard } from '../types/style';

/** Character trigram frequency vector */
function trigrams(text: string): Map<string, number> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const map = new Map<string, number>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    const tri = normalized.slice(i, i + 3);
    map.set(tri, (map.get(tri) ?? 0) + 1);
  }
  return map;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [, v] of a) normA += v * v;
  for (const [, v] of b) normB += v * v;
  for (const [k, v] of a) {
    const bv = b.get(k) ?? 0;
    dot += v * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function computeAuthorCentroid(texts: string[]): Map<string, number> {
  const combined = new Map<string, number>();
  for (const t of texts) {
    for (const [k, v] of trigrams(t)) {
      combined.set(k, (combined.get(k) ?? 0) + v);
    }
  }
  const total = [...combined.values()].reduce((a, b) => a + b, 0) || 1;
  for (const [k, v] of combined) {
    combined.set(k, v / total);
  }
  return combined;
}

export function styleSimilarity(text: string, centroid: Map<string, number>): number {
  const tri = trigrams(text);
  const total = [...tri.values()].reduce((a, b) => a + b, 0) || 1;
  const normalized = new Map<string, number>();
  for (const [k, v] of tri) normalized.set(k, v / total);
  return cosineSimilarity(normalized, centroid);
}

export function exemplarDistance(text: string, exemplars: string[]): number {
  if (!exemplars.length) return 0.5;
  const tri = trigrams(text);
  const scores = exemplars.map((e) => cosineSimilarity(tri, trigrams(e)));
  return 1 - scores.reduce((a, b) => a + b, 0) / scores.length;
}

const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const HASHTAG_RE = /#\w+/g;

export interface OutputGateOptions {
  styleCard: StyleCard;
  knownHandles: string[];
  maxWords?: number;
}

export function applyOutputGate(text: string, opts: OutputGateOptions): string {
  let out = text.trim();

  out = out.replace(URL_RE, '');
  out = out.replace(HASHTAG_RE, '');

  const allowedHandles = new Set(opts.knownHandles.map((h) => h.toLowerCase()));
  out = out.replace(/@(\w+)/g, (match, handle: string) =>
    allowedHandles.has(handle.toLowerCase()) ? match : '',
  );

  const maxWords = opts.maxWords ?? opts.styleCard.p75WordCount + 5;
  const words = out.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    out = words.slice(0, maxWords).join(' ');
  }

  const emojiLimit = Math.max(1, Math.ceil(opts.styleCard.emojiRate * words.length * 2));
  let emojiCount = 0;
  out = [...out].filter((ch) => {
    if (/\p{Extended_Pictographic}/u.test(ch)) {
      emojiCount++;
      return emojiCount <= emojiLimit;
    }
    return true;
  }).join('');

  for (const pattern of opts.styleCard.bannedPatterns) {
    try {
      out = out.replace(new RegExp(pattern, 'gi'), '');
    } catch {
      if (out.toLowerCase().includes(pattern.toLowerCase())) {
        out = out.replace(new RegExp(pattern, 'i'), '');
      }
    }
  }

  return out.replace(/\s{2,}/g, ' ').trim();
}

export interface RankableCandidate {
  text: string;
  intent: string;
  probability?: number;
}

export function rerankCandidates(
  candidates: RankableCandidate[],
  centroid: Map<string, number>,
  exemplars: string[],
  styleCard: StyleCard,
  knownHandles: string[],
): RankableCandidate[] {
  const scored = candidates.map((c) => {
    const styleScore = styleSimilarity(c.text, centroid);
    const exDist = exemplarDistance(c.text, exemplars);
    const combined = styleScore * 0.6 + (1 - exDist) * 0.3 + (c.probability ?? 0.2) * 0.1;
    const gated = applyOutputGate(c.text, { styleCard, knownHandles });
    return { ...c, text: gated, styleScore: combined };
  });

  scored.sort((a, b) => (b.styleScore ?? 0) - (a.styleScore ?? 0));
  return scored.filter((c) => c.text.length > 0).slice(0, 3);
}

export function computeDiffRatio(suggestion: string, posted: string): number {
  const a = suggestion.toLowerCase().split(/\s+/);
  const b = posted.toLowerCase().split(/\s+/);
  const setA = new Set(a);
  const overlap = b.filter((w) => setA.has(w)).length;
  return b.length === 0 ? 1 : 1 - overlap / Math.max(a.length, b.length);
}

export function checkShapeVariance(recentTexts: string[]): boolean {
  if (recentTexts.length < 3) return true;
  const lengths = recentTexts.map((t) => t.split(/\s+/).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, l) => a + (l - mean) ** 2, 0) / lengths.length;
  return variance >= 2;
}
