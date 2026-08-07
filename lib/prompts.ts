import type {
  ComposeRequest,
  Conditioning,
  PostBrief,
  RefinementChip,
  StyleCard,
  VerbalizedCandidate,
} from './types';

export const COMPOSE_CANDIDATE_COUNT = 5;

/**
 * Machine-readable chip effect. Length chips rewrite the numeric target that used to stay
 * pinned at StyleCard.medianWordCount in four places (style-facts, exemplars, rerank,
 * gate). Non-length chips keep the measured length band but carry a dominant instruction
 * plus soft rerank biases. Prior draft is intentionally not passed back — this is a
 * directed regeneration, not an edit of the previous suggestion.
 */
export interface RefinementEffect {
  chip?: RefinementChip;
  instruction: string;
  targetWordCount: number;
  wordCountP25: number;
  wordCountP75: number;
  preferQuestion: boolean;
  preferPushBack: boolean;
  preferWit: boolean;
  preferDirect: boolean;
}

/** One adjustment, threaded through prompt / exemplars / gate / rerank. */
export function resolveRefinementEffect(
  styleCard: StyleCard,
  chip?: RefinementChip,
): RefinementEffect {
  const base: RefinementEffect = {
    chip,
    instruction: '',
    targetWordCount: styleCard.medianWordCount,
    wordCountP25: styleCard.wordCountP25,
    wordCountP75: styleCard.wordCountP75,
    preferQuestion: false,
    preferPushBack: false,
    preferWit: false,
    preferDirect: false,
  };

  if (!chip) return base;

  switch (chip) {
    case 'shorter': {
      const targetWordCount = Math.max(4, Math.round(styleCard.medianWordCount * 0.55));
      const wordCountP25 = Math.max(3, Math.round(styleCard.wordCountP25 * 0.55));
      const wordCountP75 = Math.max(
        targetWordCount + 2,
        Math.round(styleCard.medianWordCount * 0.85),
      );
      return {
        ...base,
        targetWordCount,
        wordCountP25,
        wordCountP75,
        instruction:
          `REFINEMENT (overrides all length guidance): every reply must be noticeably shorter — ` +
          `aim for ~${targetWordCount} words, hard ceiling ${wordCountP75}. Cut filler; keep one point.`,
      };
    }
    case 'sharper':
      return {
        ...base,
        preferDirect: true,
        instruction:
          'REFINEMENT (overrides hedging): every reply must be more direct and pointed. ' +
          'Lead with the claim; no throat-clearing or soft openers.',
      };
    case 'funnier':
      return {
        ...base,
        preferWit: true,
        instruction:
          'REFINEMENT (overrides earnest tone): every reply needs dry wit. ' +
          'No forced punchlines, no emoji comedy, no "lol" padding.',
      };
    case 'less_agreeable':
      return {
        ...base,
        preferPushBack: true,
        instruction:
          'REFINEMENT (overrides agreeableness): push back or complicate. ' +
          'Ban sycophantic openers ("great point", "this!", "love this", "so true").',
      };
    case 'add_question':
      return {
        ...base,
        preferQuestion: true,
        instruction:
          'REFINEMENT (overrides closing style): every candidate must end with a genuine question ' +
          'that invites a real answer (must include "?").',
      };
  }
}

/** StyleCard length fields rewritten for the active chip (or unchanged). */
export function styleCardForRefinement(styleCard: StyleCard, effect: RefinementEffect): StyleCard {
  if (!effect.chip) return styleCard;
  return {
    ...styleCard,
    medianWordCount: effect.targetWordCount,
    wordCountP25: effect.wordCountP25,
    wordCountP75: effect.wordCountP75,
  };
}

const BANNED_WORDS = [
  'delve',
  'underscore',
  'meticulous',
  'commendable',
  'tapestry',
  'intricate',
];

export function fenceUntrusted(label: string, content: string): string {
  // A fence the content can close is not a fence. Observed 2026-08-06: a reply containing
  // the literal closing tag ended the block and its remaining text landed in the
  // instruction channel, which is exactly what I7 forbids. Applies to every fenced field,
  // not just the one that surfaced it.
  const neutralized = content.replace(/<\/?untrusted_[a-z_]*>/gi, '[fence]');
  return `<untrusted_${label}>\n${neutralized}\n</untrusted_${label}>`;
}

/** X handles are 1–15 chars of letters, digits, underscore (F9). */
export function sanitizeAuthorHandle(handle: string): string {
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : 'unknown';
}

export function buildComprehendPrompt(postBrief: PostBrief, imageDescription?: string): string {
  const repliesBlock =
    postBrief.topReplies.length > 0
      ? postBrief.topReplies.map((r) => `@${r.handle}: ${r.text}`).join('\n')
      : '(none captured)';
  const authorHandle = sanitizeAuthorHandle(postBrief.authorHandle);

  return `You are a structured analysis module. Output ONLY valid JSON with no markdown fences.

Analyze the post below and return:
{
  "claim": "one sentence summary of the main claim",
  "tone": "e.g. earnest, sarcastic, promotional",
  "domain": "topic area in 2-4 words",
  "entities": ["named entities and @handles mentioned"],
  "imageDescription": "description of visual content or empty string",
  "repliesAlreadySaid": ["distinct angles already taken in top replies — max 6 short phrases"]
}

${fenceUntrusted('post', postBrief.text)}
Author: @${authorHandle}
${imageDescription ? fenceUntrusted('image', imageDescription) : ''}
${fenceUntrusted('top_replies', repliesBlock)}`;
}

/** Valid-JSON output contract. A template with `|` unions or `...` invites unparseable echoes. */
export const COMPOSE_OUTPUT_CONTRACT = `Generate exactly ${COMPOSE_CANDIDATE_COUNT} candidate replies using verbalized sampling.

Respond with a single JSON object and nothing else — no markdown fences, no commentary before or after:
{
  "candidates": [
    {"text": "first reply draft", "intent": "Add", "probability": 0.3},
    {"text": "second reply draft", "intent": "Ask", "probability": 0.25},
    {"text": "third reply draft", "intent": "Push back", "probability": 0.2},
    {"text": "fourth reply draft", "intent": "Add", "probability": 0.15},
    {"text": "fifth reply draft", "intent": "Ask", "probability": 0.1}
  ]
}

Rules for the JSON:
- "candidates" holds exactly ${COMPOSE_CANDIDATE_COUNT} objects.
- "intent" is exactly one of: "Add", "Ask", "Push back".
- "probability" is a number between 0 and 1; the five should sum to about 1.0.
- Each reply must be distinct in angle.`;

function composeMediaBlock(req: ComposeRequest): string {
  const desc = req.comprehend.imageDescription.trim();
  if (desc) return fenceUntrusted('post_image', desc);
  // Silence is not acceptable when the post clearly has media (§7.4).
  const hasMedia = req.postBrief.media.some(
    (m) => m.type === 'photo' || m.type === 'animated_gif' || m.type === 'video',
  );
  if (hasMedia) {
    return fenceUntrusted(
      'post_image',
      'Media is present on this post but could not be described.',
    );
  }
  return '';
}

/**
 * Stable compose prefix — voice framing, style facts, conditioning, output contract.
 * Safe to put in createCachedContent (no fenced untrusted post content — I7).
 * Refinement instruction is included when present so length chips stay consistent with cache.
 */
export function buildComposeCachePrefix(req: ComposeRequest): string {
  const { styleCard, conditioning, refinement, username } = req;
  const effect = resolveRefinementEffect(styleCard, refinement);
  const lengthCard = styleCardForRefinement(styleCard, effect);

  const sections: string[] = [
    `Complete what @${username} would post as a reply. Write in third person about @${username}'s voice — do NOT address the reader as "you".`,
    effect.instruction,
    `Style facts (measured, not aspirational):
- Target ~${lengthCard.medianWordCount} words (${lengthCard.wordCountP25}-${lengthCard.wordCountP75} range)
- Contraction rate: ${(styleCard.contractionRate * 100).toFixed(0)}%
- Emoji rate: max ~${styleCard.emojiRate.toFixed(2)} emoji per reply
- Lowercase openers: ${(styleCard.lowercaseOpenerRate * 100).toFixed(0)}% of the time
- Signature phrases (use sparingly): ${styleCard.signaturePhrases.slice(0, 5).join(', ') || 'none'}
- NEVER use antithesis constructions (not X, but Y; not just…; it's not about…)
- NEVER use: ${BANNED_WORDS.join(', ')}
- No URLs, no hashtags, no @handles not in the thread`,
    conditioningBlock(conditioning),
    COMPOSE_OUTPUT_CONTRACT,
  ];

  return sections.map((s) => s.trim()).filter(Boolean).join('\n\n');
}

/**
 * Per-request compose suffix — fenced post context, exemplars, replies-already-said.
 * Never put this in createCachedContent (I7).
 */
export function buildComposeDynamicSuffix(req: ComposeRequest): string {
  const { comprehend, exemplars, username } = req;
  const sections: string[] = [
    `Avoid repeating what top replies already said:
${fenceUntrusted(
  'replies_already_said',
  comprehend.repliesAlreadySaid.map((r) => `- ${r}`).join('\n') || '- (none listed)',
)}`,
    exemplars.length > 0
      ? `Exemplars of @${username}'s reply style (match length and register, NOT topic):\n${exemplars
          .map((e, i) => `${i + 1}. ${e}`)
          .join('\n')}`
      : 'No exemplars captured yet — write plainly and conversationally, no marketing register.',
    fenceUntrusted('post_claim', comprehend.claim),
    fenceUntrusted('post_tone', comprehend.tone),
    fenceUntrusted('post_text', req.postBrief.text),
    composeMediaBlock(req),
  ];

  return sections.map((s) => s.trim()).filter(Boolean).join('\n\n');
}

export function buildComposePrompt(req: ComposeRequest): string {
  return [buildComposeCachePrefix(req), buildComposeDynamicSuffix(req)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');
}

function conditioningBlock(c: Conditioning): string {
  const parts: string[] = [];
  if (c.knownFor) parts.push(`Known for: ${c.knownFor}`);
  if (c.neverMention) parts.push(`Never mention: ${c.neverMention}`);
  if (c.defaultIntent) parts.push(`Default intent bias: ${c.defaultIntent}`);
  return parts.length ? `Conditioning:\n${parts.join('\n')}` : '';
}

const COMPOSE_INTENTS = ['Add', 'Ask', 'Push back'] as const;

/** Candidate before probability back-fill — probability may still be unknown. */
interface PartialCandidate {
  text: string;
  intent: VerbalizedCandidate['intent'];
  probability: number | null;
}

/**
 * Never rejects: an unrecognized angle becomes "Add" rather than dropping the whole reply.
 * Dropping on a strict enum is how five perfectly good drafts turn into a parse error.
 */
function normalizeIntent(raw: unknown): VerbalizedCandidate['intent'] {
  if (typeof raw !== 'string') return 'Add';
  const trimmed = raw.trim();
  if ((COMPOSE_INTENTS as readonly string[]).includes(trimmed)) {
    return trimmed as VerbalizedCandidate['intent'];
  }
  const lower = trimmed.toLowerCase();
  if (/push|back|disagree|challenge|counter|contrarian|rebut/.test(lower)) return 'Push back';
  if (/ask|question|curious|probe|inquir/.test(lower)) return 'Ask';
  return 'Add';
}

function normalizeProbability(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1 ? raw / 100 : raw;
  }
  if (typeof raw === 'string') {
    const value = Number.parseFloat(raw.replace('%', ''));
    if (!Number.isFinite(value)) return null;
    return raw.includes('%') || value > 1 ? value / 100 : value;
  }
  return null;
}

const TEXT_KEYS = ['text', 'reply', 'candidate', 'content', 'message', 'output', 'response', 'draft'];
const INTENT_KEYS = ['intent', 'angle', 'type', 'mode', 'strategy'];
const PROBABILITY_KEYS = ['probability', 'prob', 'weight', 'confidence', 'score', 'p'];
const ARRAY_KEYS = ['candidates', 'replies', 'responses', 'results', 'items', 'drafts', 'suggestions'];

function firstString(item: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value
        .map((v) => (typeof v === 'string' ? v : typeof (v as { text?: string })?.text === 'string' ? (v as { text: string }).text : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
      if (joined) return joined;
    }
  }
  return null;
}

function firstValue(item: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null) return item[key];
  }
  return undefined;
}

/** Strip JSON/markdown residue a salvaged fragment may carry. */
function cleanCandidateText(text: string): string {
  return text
    .replace(/^["'`\s]+|["'`,\s]+$/g, '')
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const SCAFFOLDING_RE =
  /^(candidates?|replies|reply text|intent|probability|json|output|first|second|third|fourth|fifth)\b/i;

function isUsableText(text: string): boolean {
  if (text.length < 8) return false;
  if (SCAFFOLDING_RE.test(text)) return false;
  if (/^[[{\]}]/.test(text)) return false;
  if (text.endsWith(':')) return false;
  if (/"\s*:/.test(text)) return false;
  return /[a-z]/i.test(text);
}

function normalizeCandidate(raw: unknown): PartialCandidate | null {
  if (typeof raw === 'string') {
    const text = cleanCandidateText(raw);
    return isUsableText(text) ? { text, intent: 'Add', probability: null } : null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const item = raw as Record<string, unknown>;
  const rawText = firstString(item, TEXT_KEYS);
  if (!rawText) return null;

  const text = cleanCandidateText(rawText);
  if (!isUsableText(text)) return null;

  return {
    text,
    intent: normalizeIntent(firstValue(item, INTENT_KEYS)),
    probability: normalizeProbability(firstValue(item, PROBABILITY_KEYS)),
  };
}

function extractCandidateArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ARRAY_KEYS) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    // A single candidate object returned bare.
    if (firstString(obj, TEXT_KEYS)) return [obj];
  }
  return null;
}

function candidatesFromJson(text: string): PartialCandidate[] {
  try {
    const items = extractCandidateArray(JSON.parse(text));
    if (!items) return [];
    return items.map(normalizeCandidate).filter((c): c is PartialCandidate => c !== null);
  } catch {
    return [];
  }
}

function stripFences(raw: string): string {
  return raw.replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
}

function fencedBlocks(raw: string): string[] {
  const blocks: string[] = [];
  const re = /```[a-z]*\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

/** Balanced, string-aware scan — a greedy /\{[\s\S]*\}/ swallows prose between braces. */
function balancedSpans(text: string, open: '{' | '[', close: '}' | ']'): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === close && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}

/**
 * Every balanced `{...}` at any nesting depth. Depth-0 scanning finds nothing when the
 * enclosing array/object was never closed, which is exactly the truncated-output case.
 */
function nestedObjectSpans(text: string): string[] {
  const spans: string[] = [];
  const starts: number[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') starts.push(i);
    else if (ch === '}') {
      const start = starts.pop();
      if (start !== undefined) spans.push(text.slice(start, i + 1));
    }
  }
  return spans;
}

/** True when the text opens a JSON container it never closes — the max_output_tokens signature. */
export function looksTruncatedJson(raw: string): boolean {
  const text = stripFences(raw).trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return false;
  const closer = text.startsWith('{') ? '}' : ']';
  return !text.endsWith(closer);
}

function candidatesFromPlainText(raw: string): PartialCandidate[] {
  const text = stripFences(raw);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const numbered = lines
    .map((l) => l.match(/^\d+[.):]\s*(.+)$/)?.[1])
    .filter((v): v is string => !!v);
  const bulleted = lines
    .map((l) => l.match(/^[-*•]\s*(.+)$/)?.[1])
    .filter((v): v is string => !!v);
  const quoted = [...text.matchAll(/"([^"\\]{12,300})"/g)]
    .map((m) => m[1]!)
    .filter((v) => !/^[a-z_]+$/i.test(v));

  const pools = [numbered, bulleted, quoted, lines];
  for (const pool of pools) {
    const cleaned = pool.map(cleanCandidateText).filter(isUsableText);
    const unique = [...new Set(cleaned)];
    if (unique.length > 0) {
      return unique.slice(0, COMPOSE_CANDIDATE_COUNT).map((t) => ({
        text: t,
        intent: 'Add' as const,
        probability: null,
      }));
    }
  }
  return [];
}

function finalize(partials: PartialCandidate[]): VerbalizedCandidate[] {
  const seen = new Set<string>();
  const unique: PartialCandidate[] = [];
  for (const c of partials) {
    const key = c.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  const fallbackProbability = unique.length > 0 ? 1 / unique.length : 0;
  return unique.map((c) => ({
    text: c.text,
    intent: c.intent,
    probability: c.probability ?? fallbackProbability,
  }));
}

export type CandidateParseStrategy =
  | 'strict-json'
  | 'fenced-json'
  | 'object-scan'
  | 'array-scan'
  | 'salvaged-json'
  | 'plain-text'
  | 'none';

export interface CandidateParseResult {
  candidates: VerbalizedCandidate[];
  strategy: CandidateParseStrategy;
  truncated: boolean;
}

/**
 * Layered recovery: strict JSON, fenced blocks, balanced object/array spans, salvage of
 * truncated JSON, then plain prose. Three bare sentences still yield three suggestions.
 */
export function parseCandidatesWithDiagnostics(raw: string): CandidateParseResult {
  const truncated = looksTruncatedJson(raw);
  const cleaned = stripFences(raw).trim();

  const attempts: Array<[CandidateParseStrategy, () => PartialCandidate[]]> = [
    ['strict-json', () => candidatesFromJson(cleaned)],
    [
      'fenced-json',
      () => fencedBlocks(raw).flatMap((block) => candidatesFromJson(block)),
    ],
    [
      'object-scan',
      () => balancedSpans(cleaned, '{', '}').flatMap((span) => candidatesFromJson(span)),
    ],
    [
      'array-scan',
      () => balancedSpans(cleaned, '[', ']').flatMap((span) => candidatesFromJson(span)),
    ],
    [
      // Truncated payload: every complete {...} object inside it is still usable.
      'salvaged-json',
      () =>
        nestedObjectSpans(cleaned)
          .map((span) => normalizeCandidate(safeJsonParse(span)))
          .filter((c): c is PartialCandidate => c !== null),
    ],
    ['plain-text', () => candidatesFromPlainText(raw)],
  ];

  for (const [strategy, run] of attempts) {
    const candidates = finalize(run());
    if (candidates.length > 0) return { candidates, strategy, truncated };
  }

  return { candidates: [], strategy: 'none', truncated };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseVerbalizedCandidates(raw: string): VerbalizedCandidate[] {
  return parseCandidatesWithDiagnostics(raw).candidates;
}

export function parseComprehendJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export const DEFAULT_STYLE_CARD: StyleCard = {
  medianWordCount: 14,
  wordCountP25: 8,
  wordCountP75: 22,
  contractionRate: 0.35,
  lowercaseOpenerRate: 0.5,
  emojiRate: 0.05,
  exclamationRate: 0.05,
  openers: [],
  closers: [],
  signaturePhrases: [],
  // F13: regex sources tested with RegExp; prompt describes the patterns in words.
  bannedPatterns: [
    String.raw`\bnot\s+\w+[,\s]+but\b`,
    String.raw`\bnot just\b`,
    String.raw`\bit'?s not about\b`,
  ],
  corpusSize: 0,
  updatedAt: Date.now(),
};
