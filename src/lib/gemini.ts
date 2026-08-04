import type { ComprehendResult, PostBrief, RefinementModifier, Suggestion } from '../types/post';
import type { StyleCard, UserConditioning } from '../types/style';
import { DEFAULT_STYLE_CARD } from '../types/style';
import {
  applyOutputGate,
  computeAuthorCentroid,
  rerankCandidates,
} from './rerank';
import { selectExemplars, wordCount } from './style';
import { getAllCorpus } from './storage';

const MODEL = 'gemini-2.5-flash-lite';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

async function getApiKey(): Promise<string | null> {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  return geminiApiKey ?? null;
}

async function geminiRequest(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/${MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

function extractText(response: unknown): string {
  const r = response as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return r.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

function parseJsonBlock(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error('Failed to parse JSON from model response');
  }
}

async function fetchImageBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return {
      mimeType: blob.type || 'image/webp',
      data: btoa(binary),
    };
  } catch {
    return null;
  }
}

export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/${MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Say OK' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const comprehendCache = new Map<string, ComprehendResult>();

export async function getCachedComprehend(tweetId: string): Promise<ComprehendResult | null> {
  if (comprehendCache.has(tweetId)) return comprehendCache.get(tweetId)!;
  const key = `comprehend:${tweetId}`;
  const stored = await chrome.storage.session.get(key);
  const val = stored[key] as ComprehendResult | undefined;
  if (val) comprehendCache.set(tweetId, val);
  return val ?? null;
}

async function cacheComprehend(tweetId: string, result: ComprehendResult): Promise<void> {
  comprehendCache.set(tweetId, result);
  await chrome.storage.session.set({ [`comprehend:${tweetId}`]: result });
}

/** Stage 1: Comprehend — multimodal, cached by tweet ID */
export async function runComprehend(post: PostBrief): Promise<ComprehendResult> {
  const cached = await getCachedComprehend(post.id);
  if (cached) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Gemini API key not configured');

  const parts: Array<Record<string, unknown>> = [];

  const mediaDesc = post.media
    .map((m) => m.altText ?? `[${m.type} media]`)
    .join('; ');

  const repliesText = post.topReplies.map((r) => `@${r.authorHandle}: ${r.text}`).join('\n');

  parts.push({
    text: `Analyze the following UNTRUSTED social media post data. Output ONLY valid JSON with keys: claim, tone, domain, entities (array), imageDescription, repliesAlreadySaid (array of short summaries), summary.

<untrusted_data>
Author: @${post.author.handle}
Post text: ${post.text}
Media descriptions: ${mediaDesc || 'none'}
Top replies already posted:
${repliesText || 'none captured'}
</untrusted_data>`,
  });

  const primaryMedia = post.media[0];
  if (primaryMedia?.url && !primaryMedia.altText) {
    const img = await fetchImageBase64(primaryMedia.url);
    if (img) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
  } else if (primaryMedia?.posterUrl) {
    const img = await fetchImageBase64(primaryMedia.posterUrl);
    if (img) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
  }

  const response = await geminiRequest(apiKey, {
    contents: [{ parts }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 300, responseMimeType: 'application/json' },
  });

  const text = extractText(response);
  const parsed = parseJsonBlock(text) as ComprehendResult;
  const result: ComprehendResult = {
    claim: parsed.claim ?? post.text.slice(0, 100),
    tone: parsed.tone ?? 'neutral',
    domain: parsed.domain ?? 'general',
    entities: parsed.entities ?? [],
    imageDescription: parsed.imageDescription ?? mediaDesc,
    repliesAlreadySaid: parsed.repliesAlreadySaid ?? post.topReplies.map((r) => r.text.slice(0, 80)),
    summary: parsed.summary ?? post.text.slice(0, 150),
  };

  await cacheComprehend(post.id, result);
  return result;
}

export async function prefetchComprehend(post: PostBrief): Promise<void> {
  try {
    await runComprehend(post);
  } catch (e) {
    console.warn('[X Reply Copilot] Comprehend prefetch failed:', e);
  }
}

interface ComposeCandidate {
  text: string;
  intent: string;
  probability: number;
}

/** Stage 2: Compose — text-only, verbalized sampling k=5 */
export async function runCompose(
  post: PostBrief,
  comprehend: ComprehendResult,
  styleCard: StyleCard,
  conditioning: UserConditioning,
  modifier?: RefinementModifier,
): Promise<Suggestion[]> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Gemini API key not configured');

  const corpus = await getAllCorpus();
  const targetLen = styleCard.medianWordCount;
  const exemplars = selectExemplars(corpus, targetLen, 5);

  const modifierInstruction = modifier
    ? `\nApply refinement: make the reply ${modifier.replace(/_/g, ' ')}.`
    : '';

  const prompt = `You are completing text in the voice of @${post.author.handle === conditioning.knownFor ? 'the user' : 'a specific author'}.

TASK: Generate exactly 5 candidate replies that @user would post in response to the analyzed post. Use completion-style framing — continue their voice, do NOT describe what they would say.

Style facts (measured, not adjectives):
- Median length: ${styleCard.medianWordCount} words (max ${styleCard.p75WordCount})
- Emoji rate: ${(styleCard.emojiRate * 100).toFixed(1)}% of words
- Contractions: ${(styleCard.contractionRate * 100).toFixed(0)}% of replies use them
- Openers often used: ${styleCard.openers.join(', ') || 'varied'}
- Signature phrases: ${styleCard.signaturePhrases.join(', ') || 'none detected'}
- Capitalization: ${styleCard.capitalizationStyle}

Voice exemplars (match this style, NOT the topic):
${exemplars.map((e, i) => `${i + 1}. "${e}"`).join('\n')}

User conditioning:
- Known for: ${conditioning.knownFor || 'not specified'}
- Never mention: ${conditioning.neverMention || 'nothing specified'}
- Default intent bias: ${conditioning.defaultIntent}
${modifierInstruction}

<untrusted_post_analysis>
Claim: ${comprehend.claim}
Tone: ${comprehend.tone}
Domain: ${comprehend.domain}
Summary: ${comprehend.summary}
Replies already said (AVOID repeating these angles):
${comprehend.repliesAlreadySaid.map((r) => `- ${r}`).join('\n')}
</untrusted_post_analysis>

Output ONLY valid JSON array of 5 objects: [{"text":"...","intent":"Add|Ask|Push back","probability":0.0-1.0}]
Each intent must be one of: Add, Ask, Push back. Probabilities should sum to ~1.0.`;

  const response = await geminiRequest(apiKey, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 1.0, maxOutputTokens: 800, responseMimeType: 'application/json' },
  });

  const text = extractText(response);
  let candidates: ComposeCandidate[];
  try {
    candidates = parseJsonBlock(text) as ComposeCandidate[];
  } catch {
    candidates = [{ text: text.slice(0, 280), intent: conditioning.defaultIntent, probability: 1 }];
  }

  const ownTexts = corpus.filter((c) => c.isOwnReply).map((c) => c.text);
  const centroid = computeAuthorCentroid(ownTexts.length ? ownTexts : exemplars);

  const knownHandles = [
    post.author.handle,
    ...post.topReplies.map((r) => r.authorHandle),
  ];

  const ranked = rerankCandidates(
    candidates.map((c) => ({
      text: c.text,
      intent: c.intent,
      probability: c.probability,
    })),
    centroid,
    exemplars,
    styleCard,
    knownHandles,
  );

  return ranked.map((c, i) => ({
    id: `${post.id}-${Date.now()}-${i}`,
    text: c.text,
    intent: (['Add', 'Ask', 'Push back'].includes(c.intent) ? c.intent : conditioning.defaultIntent) as Suggestion['intent'],
    probability: c.probability,
    styleScore: c.styleScore,
  }));
}

export async function loadStyleCardAndConditioning(): Promise<{
  styleCard: StyleCard;
  conditioning: UserConditioning;
}> {
  const stored = await chrome.storage.local.get(['styleCard', 'conditioning']);
  return {
    styleCard: (stored.styleCard as StyleCard) ?? DEFAULT_STYLE_CARD,
    conditioning: (stored.conditioning as UserConditioning) ?? {
      knownFor: '',
      neverMention: '',
      defaultIntent: 'Add',
    },
  };
}

export { wordCount, applyOutputGate };
