import type { ComprehendResult, ComposeRequest, PostBrief } from './types';
import type { ApiKeyValidation } from './api-validation';
import {
  buildComprehendPrompt,
  buildComposePrompt,
  parseCandidatesWithDiagnostics,
  parseComprehendJson,
} from './prompts';
import type { VerbalizedCandidate } from './types';
import { recordGenerationFailure, recordGenerationRecovery, RAW_PREVIEW_CHARS } from './debug';

/** Vision model for image comprehend (Groq multimodal). */
export const GROQ_VISION_MODEL = 'qwen/qwen3.6-27b';

/** Text models for compose; first is preferred. */
export const GROQ_TEXT_MODELS = [
  'llama-3.3-70b-versatile',
  'qwen/qwen3-32b',
  'llama-3.1-8b-instant',
] as const;

const BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';
const FETCH_TIMEOUT_MS = 25_000;
const COMPOSE_MAX_TOKENS = 2048;

type GroqContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface GroqMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | GroqContentPart[];
}

function parseGroqError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const msg = parsed.error?.message;
    if (msg) return msg;
  } catch {
    /* use raw slice */
  }
  if (status === 401 || status === 403) {
    return 'API key not valid. Check you copied the full key from console.groq.com/keys.';
  }
  if (status === 404) return 'Model not available. Trying fallback models…';
  if (status === 429) return 'Rate limit hit (429). Your key is valid — wait a minute and retry.';
  return `Groq API error ${status}: ${body.slice(0, 160)}`;
}

let activeTextModel: (typeof GROQ_TEXT_MODELS)[number] = GROQ_TEXT_MODELS[0];

async function callGroqModel(
  apiKey: string,
  model: string,
  messages: GroqMessage[],
  maxTokens = 1024,
  jsonMode = false,
): Promise<string> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages,
      temperature: 1,
      max_completion_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(parseGroqError(response.status, errText)) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  };

  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content : '';
  if (!text) {
    throw new Error(`Groq returned no text (finish_reason: ${choice?.finish_reason ?? 'unknown'}).`);
  }
  return text;
}

async function callGroqText(
  apiKey: string,
  messages: GroqMessage[],
  maxTokens = 1024,
  jsonMode = false,
): Promise<string> {
  const models = [activeTextModel, ...GROQ_TEXT_MODELS.filter((m) => m !== activeTextModel)];
  let lastError: (Error & { status?: number }) | null = null;

  for (const model of models) {
    try {
      const text = await callGroqModel(apiKey, model, messages, maxTokens, jsonMode);
      activeTextModel = model;
      return text;
    } catch (e) {
      lastError = e as Error & { status?: number };
      if (lastError.status === 401 || lastError.status === 403 || lastError.status === 429) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error('All Groq text models failed');
}

/** Validate API key — 429 counts as valid (rate limited, not rejected). */
export async function validateApiKey(apiKey: string): Promise<ApiKeyValidation> {
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith('gsk_')) {
    return { valid: false, message: 'Key should start with gsk_ (from console.groq.com/keys).' };
  }

  for (const model of GROQ_TEXT_MODELS) {
    try {
      await callGroqModel(trimmed, model, [{ role: 'user', content: 'ok' }], 4, false);
      activeTextModel = model;
      return { valid: true, message: 'Key valid ✓', model };
    } catch (e) {
      const err = e as Error & { status?: number; name?: string };
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return { valid: false, message: 'Groq API timed out. Check your network and try again.' };
      }
      if (err.status === 429) {
        activeTextModel = model;
        return {
          valid: true,
          message: 'Key valid ✓ (rate limited right now)',
          warning: 'Groq returned 429 Too Many Requests. Wait 60 seconds before generating replies.',
          model,
        };
      }
      if (err.status === 401 || err.status === 403) {
        return { valid: false, message: err.message };
      }
    }
  }

  return {
    valid: false,
    message: 'Could not reach any Groq model with this key. Check console.groq.com/keys.',
  };
}

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    const data = btoa(binary);
    const mimeType = response.headers.get('content-type') ?? 'image/webp';
    return `data:${mimeType};base64,${data}`;
  } catch {
    return null;
  }
}

/** Stage 1: multimodal comprehend — cached by tweet ID in session storage. */
export async function comprehendPost(apiKey: string, postBrief: PostBrief): Promise<ComprehendResult> {
  let imageDescription = '';

  const photo = postBrief.media.find((m) => m.type === 'photo' || m.type === 'animated_gif');
  if (photo?.altText) {
    imageDescription = photo.altText;
  } else if (photo?.url) {
    const dataUrl = await fetchImageAsDataUrl(photo.url);
    if (dataUrl) {
      try {
        imageDescription = await callGroqModel(
          apiKey,
          GROQ_VISION_MODEL,
          [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Describe this image in one sentence for reply context. Output plain text only.' },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          100,
          false,
        );
      } catch {
        imageDescription = '';
      }
    }
  }

  const video = postBrief.media.find((m) => m.type === 'video');
  if (!imageDescription && video) {
    imageDescription = video.altText ?? 'Video post (poster frame only)';
  }

  const prompt = buildComprehendPrompt(postBrief, imageDescription);
  const raw = await callGroqText(apiKey, [{ role: 'user', content: prompt }], 300, true);
  const parsed = parseComprehendJson(raw);

  return {
    claim: String(parsed?.claim ?? postBrief.text.slice(0, 120)),
    tone: String(parsed?.tone ?? 'neutral'),
    domain: String(parsed?.domain ?? 'general'),
    entities: Array.isArray(parsed?.entities) ? (parsed.entities as string[]) : [],
    imageDescription: String(parsed?.imageDescription ?? imageDescription),
    repliesAlreadySaid: Array.isArray(parsed?.repliesAlreadySaid)
      ? (parsed.repliesAlreadySaid as string[])
      : postBrief.topReplies.slice(0, 6).map((r) => r.text.slice(0, 80)),
    tweetId: postBrief.tweetId,
    cachedAt: Date.now(),
  };
}

/** Stage 2: text-only compose with verbalized sampling k=5. */
export async function composeReplies(apiKey: string, req: ComposeRequest): Promise<VerbalizedCandidate[]> {
  const prompt = buildComposePrompt(req);
  const raw = await callGroqText(apiKey, [{ role: 'user', content: prompt }], COMPOSE_MAX_TOKENS, false);
  const parsed = parseCandidatesWithDiagnostics(raw);

  const debugBase = {
    at: new Date().toISOString(),
    stage: 'compose' as const,
    provider: 'groq' as const,
    model: activeTextModel,
    route: 'chat/completions',
    maxOutputTokens: COMPOSE_MAX_TOKENS,
    parseStrategy: parsed.strategy,
    promptChars: prompt.length,
    rawLength: raw.length,
    rawPreview: raw.slice(0, RAW_PREVIEW_CHARS),
  };

  if (parsed.candidates.length === 0) {
    recordGenerationFailure({
      ...debugBase,
      truncated: parsed.truncated,
      error: 'No candidates recovered from model response',
    });
    throw new Error(
      parsed.truncated
        ? `${activeTextModel} was cut off before it finished writing (hit its ${COMPOSE_MAX_TOKENS}-token output limit). Retry, or use the Shorter chip.`
        : `${activeTextModel} replied, but nothing usable could be read out of it. The raw response is in the service worker console.`,
    );
  }

  if (parsed.strategy !== 'strict-json') {
    recordGenerationRecovery({
      ...debugBase,
      error: `recovered ${parsed.candidates.length} via ${parsed.strategy}`,
    });
  }

  return parsed.candidates;
}
