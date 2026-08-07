import type { ComprehendResult, ComposeRequest, MediaItem, PostBrief } from './types';
import type { ApiKeyValidation } from './api-validation';
import {
  buildComprehendPrompt,
  buildComposeCachePrefix,
  buildComposeDynamicSuffix,
  buildComposePrompt,
  parseCandidatesWithDiagnostics,
  parseComprehendJson,
} from './prompts';
import type { VerbalizedCandidate } from './types';
import {
  mediaDebug,
  recordGenerationFailure,
  recordGenerationRecovery,
  RAW_PREVIEW_CHARS,
} from './debug';
import {
  combineMediaDescriptions,
  fallbackDescriptionForMedia,
  MEDIA_UNREADABLE,
  selectMediaForDescription,
  visionPromptForMedia,
} from './media';
import { postBriefHasVisualMedia } from './post-brief';
import { getSettings } from './storage';
import { ensureComposeCache } from './gemini-cache';
import { parseUsagePayload, recordUsage, type UsageStage } from './usage';

/**
 * Preference order when multiple flash models are available.
 * Default #1 is 3.1-flash-lite — 2.5-flash-lite is omitted (unavailable on newer accounts).
 */
export const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
] as const;

/** Models removed from the product UI; migrate stored pins away from these. */
export const RETIRED_GEMINI_MODELS = ['gemini-2.5-flash-lite'] as const;

export type GeminiAuthMode = 'query-key' | 'x-goog-api-key' | 'bearer' | 'interactions';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';

/*
 * AQ (auth) key smoke test — PowerShell:
 *
 * $key = "AQ...."
 * # ListModels (works for most AQ keys):
 * Invoke-RestMethod "https://generativelanguage.googleapis.com/v1beta/models?key=$key"
 *
 * # generateContent — may 404 on AQ keys; use x-goog-api-key header first:
 * Invoke-RestMethod -Method POST `
 *   -Uri "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" `
 *   -Headers @{ "x-goog-api-key" = $key; "Content-Type" = "application/json" } `
 *   -Body '{"contents":[{"parts":[{"text":"ok"}]}],"generationConfig":{"maxOutputTokens":4}}'
 *
 * # Interactions API — primary path for AQ keys when generateContent 404s:
 * Invoke-RestMethod -Method POST `
 *   -Uri "https://generativelanguage.googleapis.com/v1beta/interactions" `
 *   -Headers @{ "x-goog-api-key" = $key; "Content-Type" = "application/json"; "Api-Revision" = "2026-05-20" } `
 *   -Body '{"model":"gemini-2.5-flash","input":"ok","store":false,"generation_config":{"max_output_tokens":4}}'
 */

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  /** Public image URL for Interactions API (pbs.twimg.com). */
  imageUri?: string;
  imageMimeType?: string;
}

type InteractionInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data?: string; uri?: string; mime_type: string };

interface GeminiApiErrorBody {
  error?: { message?: string; status?: string };
}

interface InteractionContentItem {
  type?: string;
  text?: string;
}

interface InteractionStep {
  type?: string;
  status?: string;
  content?: InteractionContentItem[] | string;
  summary?: InteractionContentItem[];
  text?: string;
}

/**
 * REST responses carry `steps`; `output_text` is an SDK convenience property. Legacy revisions
 * used `outputs`. Accept every shape rather than guessing which one this key/revision returns.
 */
interface InteractionResponse {
  id?: string;
  /** completed | incomplete (hit max_tokens) | failed | requires_action | ... */
  status?: string;
  output_text?: string;
  outputText?: string;
  steps?: InteractionStep[];
  outputs?: InteractionStep[];
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usage?: unknown;
  error?: { message?: string };
}

interface ListModelEntry {
  name?: string;
  supportedGenerationMethods?: string[];
}

function parseErrorBody(body: string): GeminiApiErrorBody | null {
  try {
    return JSON.parse(body) as GeminiApiErrorBody;
  } catch {
    return null;
  }
}

function shortModelName(fullName?: string): string | null {
  if (!fullName) return null;
  return fullName.replace(/^models\//, '');
}

/** True when the model name/path is missing or lacks generateContent on this key. */
function isModelNotFound(status: number, body: string): boolean {
  if (status === 404) return true;
  const parsed = parseErrorBody(body);
  const msg = (parsed?.error?.message ?? body).toLowerCase();
  const errStatus = (parsed?.error?.status ?? '').toUpperCase();
  return (
    errStatus === 'NOT_FOUND' ||
    msg.includes('is not found') ||
    msg.includes('not supported for generatecontent')
  );
}

function parseGeminiError(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return 'API key not valid. Check you copied the full key from AI Studio.';
  }
  if (isModelNotFound(status, body)) {
    return 'Model not available on this key. Trying next model…';
  }
  if (status === 429) {
    return 'Rate limit hit. Your key is valid — wait a minute and retry.';
  }

  const parsed = parseErrorBody(body);
  const msg = parsed?.error?.message;
  if (msg) {
    if (
      msg.includes('generativelanguage.googleapis.com') ||
      /^models\//i.test(msg) ||
      msg.includes('API version v1beta')
    ) {
      return 'Gemini request failed. Check your API key or try again shortly.';
    }
    return msg;
  }

  return `Gemini API error (${status}). Try again in a moment.`;
}

const FETCH_TIMEOUT_MS = 25_000;
/** Abandon further model/route fallbacks once this wall clock is exceeded (§5.4). */
export const COMPOSE_WALL_CLOCK_MS = 8_000;

const DEFAULT_MAX_TOKENS = 2048;
/** Five drafts plus JSON scaffolding, with headroom for any thinking the API still does. */
const COMPOSE_MAX_TOKENS = 4096;
const COMPREHEND_MAX_TOKENS = 2048;
const VISION_MAX_TOKENS = 512;

function isAuthKey(apiKey: string): boolean {
  return apiKey.startsWith('AQ.');
}

function isGeminiKeyFormat(key: string): boolean {
  return key.startsWith('AIza') || key.startsWith('AQ.');
}

function isFlashModel(name: string): boolean {
  return /flash/i.test(name);
}

function modelSupportsGeneration(entry: ListModelEntry): boolean {
  const methods = entry.supportedGenerationMethods ?? [];
  if (methods.length === 0) return true;
  return methods.includes('generateContent') || methods.includes('interact');
}

function sortModelsByPreference(models: string[]): string[] {
  const rank = (name: string): number => {
    const idx = (GEMINI_MODELS as readonly string[]).indexOf(name);
    return idx >= 0 ? idx : GEMINI_MODELS.length;
  };
  return [...new Set(models)].sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}

/** Header/query auth modes for generateContent and ListModels (never combine ?key= with Bearer). */
function headerAuthModes(apiKey: string, preferred?: GeminiAuthMode): GeminiAuthMode[] {
  const base: GeminiAuthMode[] = isAuthKey(apiKey)
    ? ['x-goog-api-key', 'query-key', 'bearer']
    : ['query-key', 'x-goog-api-key'];

  if (preferred && preferred !== 'interactions' && base.includes(preferred)) {
    return [preferred, ...base.filter((m) => m !== preferred)];
  }
  return base;
}

function applyAuth(
  url: string,
  apiKey: string,
  mode: GeminiAuthMode,
  init: RequestInit = {},
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };

  if (init.method !== 'GET' && init.body) {
    headers['Content-Type'] = 'application/json';
  }

  switch (mode) {
    case 'query-key':
      return {
        url: `${url}?key=${encodeURIComponent(apiKey)}`,
        init: { ...init, headers },
      };
    case 'x-goog-api-key':
      return {
        url,
        init: { ...init, headers: { ...headers, 'x-goog-api-key': apiKey } },
      };
    case 'bearer':
      return {
        url,
        init: { ...init, headers: { ...headers, Authorization: `Bearer ${apiKey}` } },
      };
    default:
      return { url, init: { ...init, headers } };
  }
}

function shouldRetryAuth(status: number): boolean {
  return status === 401 || status === 403;
}

function shouldRetryAuthForListModels(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

async function loadGeminiPrefs(): Promise<{ model?: string; authMode?: GeminiAuthMode }> {
  const result = await chrome.storage.local.get(['preferredGeminiModel', 'geminiAuthMode']);
  return {
    model: result.preferredGeminiModel as string | undefined,
    authMode: result.geminiAuthMode as GeminiAuthMode | undefined,
  };
}

async function persistGeminiPrefs(model: string, authMode: GeminiAuthMode): Promise<void> {
  const current = await loadGeminiPrefs();
  if (current.model === model && current.authMode === authMode) return;
  await chrome.storage.local.set({ preferredGeminiModel: model, geminiAuthMode: authMode });
  console.info(`[Gemini] persisted model=${model} authMode=${authMode}`);
}

/** Cold workers must not pay ListModels on every wake when a fresh list is already stored. */
export const DISCOVERED_MODELS_TTL_MS = 24 * 60 * 60 * 1000;

async function persistDiscoveredModels(models: string[]): Promise<void> {
  await chrome.storage.local.set({
    discoveredGeminiModels: models,
    discoveredGeminiModelsAt: Date.now(),
  });
}

async function loadStoredDiscoveredModels(): Promise<{ models: string[]; at: number } | null> {
  const result = await chrome.storage.local.get([
    'discoveredGeminiModels',
    'discoveredGeminiModelsAt',
  ]);
  const stored = result.discoveredGeminiModels;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  const at =
    typeof result.discoveredGeminiModelsAt === 'number'
      ? result.discoveredGeminiModelsAt
      : 0;
  return { models: stored as string[], at };
}

/** Try auth modes until one succeeds or all are exhausted. */
async function geminiFetchWithAuth(
  apiKey: string,
  url: string,
  init: RequestInit,
  modes: GeminiAuthMode[],
  label: string,
  retryOn404 = false,
): Promise<{ response: Response; authMode: GeminiAuthMode }> {
  let lastResponse: Response | null = null;
  let lastMode = modes[0] ?? 'query-key';

  for (const mode of modes) {
    const { url: authedUrl, init: authedInit } = applyAuth(url, apiKey, mode, init);
    const response = await fetch(authedUrl, {
      ...authedInit,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    lastResponse = response;
    lastMode = mode;

    if (response.ok) {
      console.info(`[Gemini] auth=${mode} ok ${label}`);
      return { response, authMode: mode };
    }

    const retry = retryOn404 ? shouldRetryAuthForListModels(response.status) : shouldRetryAuth(response.status);
    if (retry && mode !== modes[modes.length - 1]) {
      console.info(`[Gemini] auth=${mode} failed (${response.status}) for ${label}, trying next auth`);
      continue;
    }

    return { response, authMode: mode };
  }

  return { response: lastResponse!, authMode: lastMode };
}

function partsToInteractionInput(parts: GeminiPart[]): string | InteractionInputItem[] {
  const items: InteractionInputItem[] = [];
  for (const part of parts) {
    if (part.text) items.push({ type: 'text', text: part.text });
    if (part.inlineData) {
      items.push({
        type: 'image',
        data: part.inlineData.data,
        mime_type: part.inlineData.mimeType,
      });
    } else if (part.imageUri) {
      items.push({
        type: 'image',
        uri: part.imageUri,
        mime_type: part.imageMimeType ?? 'image/webp',
      });
    }
  }
  return items.length === 1 && items[0]?.type === 'text' ? items[0].text : items;
}

function hasMultimodalInput(parts: GeminiPart[]): boolean {
  return parts.some((p) => p.inlineData || p.imageUri);
}

async function resolvePartsForGenerateContent(parts: GeminiPart[]): Promise<GeminiPart[]> {
  const resolved: GeminiPart[] = [];
  for (const part of parts) {
    if (part.text) resolved.push({ text: part.text });
    if (part.inlineData) resolved.push({ inlineData: part.inlineData });
    else if (part.imageUri) {
      const imageData = await fetchImageAsBase64(part.imageUri);
      if (imageData) resolved.push({ inlineData: imageData });
    }
  }
  return resolved;
}

function stepTexts(step: InteractionStep): string[] {
  if (typeof step.content === 'string') return [step.content];
  const texts: string[] = [];
  for (const item of step.content ?? []) {
    if (item.text && (item.type === 'text' || item.type === undefined)) texts.push(item.text);
  }
  if (texts.length === 0 && step.text) texts.push(step.text);
  return texts;
}

/** Depth-limited sweep for `{type:"text", text:"…"}` nodes in an envelope we don't recognize. */
function harvestTextNodes(value: unknown, depth = 0): string[] {
  if (depth > 6 || !value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((v) => harvestTextNodes(v, depth + 1));

  const obj = value as Record<string, unknown>;
  if (obj.type === 'text' && typeof obj.text === 'string' && obj.text.trim()) {
    return [obj.text];
  }
  return Object.values(obj).flatMap((v) => harvestTextNodes(v, depth + 1));
}

interface InteractionExtraction {
  text: string;
  /** Model spent its budget thinking and never emitted an answer. */
  thoughtsOnly: boolean;
}

function extractInteractionText(data: InteractionResponse): InteractionExtraction {
  const convenience = data.output_text ?? data.outputText;
  if (typeof convenience === 'string' && convenience.trim()) {
    return { text: convenience, thoughtsOnly: false };
  }

  const steps = data.steps ?? data.outputs ?? [];

  const modelOutput = steps
    .filter((s) => s.type === 'model_output')
    .flatMap(stepTexts)
    .join('');
  if (modelOutput.trim()) return { text: modelOutput, thoughtsOnly: false };

  const nonThought = steps
    .filter((s) => s.type !== 'thought' && s.type !== 'user_input')
    .flatMap(stepTexts)
    .join('');
  if (nonThought.trim()) return { text: nonThought, thoughtsOnly: false };

  const generateContentShape = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('');
  if (generateContentShape?.trim()) return { text: generateContentShape, thoughtsOnly: false };

  const hasThoughts = steps.some((s) => s.type === 'thought');
  const harvested = harvestTextNodes(steps).join('');
  if (harvested.trim() && !hasThoughts) return { text: harvested, thoughtsOnly: false };

  return { text: '', thoughtsOnly: hasThoughts };
}

export type GeminiRoute = 'interactions' | 'generateContent';

export interface GenerationMeta {
  route: GeminiRoute;
  model: string;
  authMode: GeminiAuthMode;
  httpStatus: number;
  maxOutputTokens: number;
  /** Interactions API interaction.status; "incomplete" means max_output_tokens was hit. */
  interactionStatus?: string;
  finishReason?: string;
  safety?: unknown;
  usage?: unknown;
  /** Output was cut short (interaction incomplete or finishReason MAX_TOKENS). */
  truncated: boolean;
  thinkingControlled: boolean;
}

export interface GenerationResult {
  text: string;
  meta: GenerationMeta;
}

type GeminiCallError = Error & {
  status?: number;
  modelNotFound?: boolean;
  rawBody?: string;
  route?: GeminiRoute;
};

function makeGeminiError(status: number, body: string): GeminiCallError {
  const err = new Error(parseGeminiError(status, body)) as GeminiCallError;
  err.status = status;
  err.modelNotFound = isModelNotFound(status, body);
  err.rawBody = body;
  return err;
}

/**
 * gemini-2.5-flash defaults to dynamic thinking, and thinking tokens are drawn from the same
 * max_output_tokens budget as the answer. Without this the model can spend the entire budget
 * reasoning and return truncated (or no) JSON.
 */
function interactionsThinkingConfig(): Record<string, unknown> {
  return { thinking_level: 'minimal', thinking_summaries: 'none' };
}

function generateContentThinkingConfig(model: string): Record<string, unknown> | null {
  // 2.5-series: thinkingBudget 0 disables thinking (R4 — keep untouched on happy path).
  if (/gemini-2\.5/.test(model)) {
    return { thinkingConfig: { thinkingBudget: 0 } };
  }
  // 3.x: cannot fully disable; thinkingLevel minimal matches "no thinking" for most queries.
  if (/gemini-3/.test(model)) {
    return { thinkingConfig: { thinkingLevel: 'minimal' } };
  }
  return null;
}

/**
 * Budget when the API rejects thinking controls. Previously inflated to 16384, which
 * turned the fallback into unbounded thinking. Cap is a small headroom only.
 */
export const CONFIG_REJECTION_TOKEN_CEILING = 5120;

/** @internal exported for Wave 2 harness verification */
export function inflatedTokenBudget(maxTokens: number): number {
  return Math.min(maxTokens + 512, CONFIG_REJECTION_TOKEN_CEILING);
}

function isConfigRejection(err: GeminiCallError): boolean {
  if (err.status !== 400) return false;
  const body = (err.rawBody ?? err.message).toLowerCase();
  return (
    body.includes('thinking') ||
    body.includes('unknown name') ||
    body.includes('cannot find field') ||
    body.includes('invalid_argument') ||
    body.includes('invalid json payload')
  );
}

async function postInteractions(
  apiKey: string,
  model: string,
  parts: GeminiPart[],
  maxTokens: number,
  jsonMode: boolean,
  withThinkingControl: boolean,
  preferredAuth?: GeminiAuthMode,
): Promise<GenerationResult> {
  const body: Record<string, unknown> = {
    model,
    input: partsToInteractionInput(parts),
    store: false,
    generation_config: {
      temperature: 1.0,
      max_output_tokens: maxTokens,
      ...(withThinkingControl ? interactionsThinkingConfig() : {}),
    },
  };

  if (jsonMode) {
    body.response_format = { type: 'text', mime_type: 'application/json' };
  }

  const { response } = await geminiFetchWithAuth(
    apiKey,
    INTERACTIONS_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Revision': API_REVISION,
      },
      body: JSON.stringify(body),
    },
    headerAuthModes(apiKey, preferredAuth),
    `interactions ${model}`,
  );

  if (!response.ok) {
    const err = makeGeminiError(response.status, await response.text());
    err.route = 'interactions';
    throw err;
  }

  const data = (await response.json()) as InteractionResponse;
  const { text, thoughtsOnly } = extractInteractionText(data);
  const truncated = data.status === 'incomplete' || data.status === 'budget_exceeded';

  const meta: GenerationMeta = {
    route: 'interactions',
    model,
    authMode: 'interactions',
    httpStatus: response.status,
    maxOutputTokens: maxTokens,
    interactionStatus: data.status,
    usage: data.usage,
    truncated,
    thinkingControlled: withThinkingControl,
  };

  if (!text) {
    const reason = thoughtsOnly
      ? 'the model used its whole output budget on internal reasoning'
      : truncated
        ? 'the response was cut off before any text was produced'
        : 'the response contained no text';
    const err = new Error(`Gemini returned no usable text — ${reason}.`) as GeminiCallError;
    err.status = response.status;
    err.route = 'interactions';
    err.rawBody = JSON.stringify(data).slice(0, 1000);
    throw err;
  }

  return { text, meta };
}

async function callGeminiInteractions(
  apiKey: string,
  model: string,
  parts: GeminiPart[],
  maxTokens: number,
  jsonMode: boolean,
  preferredAuth?: GeminiAuthMode,
): Promise<GenerationResult> {
  try {
    return await postInteractions(apiKey, model, parts, maxTokens, jsonMode, true, preferredAuth);
  } catch (e) {
    const err = e as GeminiCallError;
    if (!isConfigRejection(err)) throw err;

    const fallbackTokens = inflatedTokenBudget(maxTokens);
    console.warn(
      `[Gemini] thinking control rejected for ${model} on interactions; ` +
        `retrying without thinking fields at max_output_tokens=${fallbackTokens}`,
    );
    return postInteractions(
      apiKey,
      model,
      parts,
      fallbackTokens,
      jsonMode,
      false,
      preferredAuth,
    );
  }
}

async function postGenerateContent(
  apiKey: string,
  model: string,
  resolvedParts: GeminiPart[],
  maxTokens: number,
  jsonMode: boolean,
  withThinkingControl: boolean,
  preferredAuth?: GeminiAuthMode,
  cachedContentName?: string,
): Promise<GenerationResult> {
  const thinking = withThinkingControl ? generateContentThinkingConfig(model) : null;
  const bodyObj: Record<string, unknown> = {
    contents: [{ parts: resolvedParts }],
    generationConfig: {
      temperature: 1.0,
      maxOutputTokens: maxTokens,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
      ...(thinking ?? {}),
    },
  };
  if (cachedContentName) {
    bodyObj.cachedContent = cachedContentName;
  }
  const body = JSON.stringify(bodyObj);

  const { response, authMode } = await geminiFetchWithAuth(
    apiKey,
    `${BASE_URL}/${model}:generateContent`,
    { method: 'POST', body },
    headerAuthModes(apiKey, preferredAuth),
    `generateContent ${model}`,
  );

  if (!response.ok) {
    const err = makeGeminiError(response.status, await response.text());
    err.route = 'generateContent';
    throw err;
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
      safetyRatings?: unknown;
    }>;
    promptFeedback?: { blockReason?: string; safetyRatings?: unknown };
    usageMetadata?: unknown;
  };

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const finishReason = candidate?.finishReason;

  const meta: GenerationMeta = {
    route: 'generateContent',
    model,
    authMode,
    httpStatus: response.status,
    maxOutputTokens: maxTokens,
    finishReason,
    safety: data.promptFeedback ?? candidate?.safetyRatings,
    usage: data.usageMetadata,
    truncated: finishReason === 'MAX_TOKENS',
    thinkingControlled: thinking !== null,
  };

  if (!text) {
    const blocked = data.promptFeedback?.blockReason;
    const err = new Error(
      blocked
        ? `Gemini blocked this request (${blocked}).`
        : `Gemini returned no text (finishReason: ${finishReason ?? 'unknown'}).`,
    ) as GeminiCallError;
    err.status = response.status;
    err.route = 'generateContent';
    err.rawBody = JSON.stringify(data).slice(0, 1000);
    throw err;
  }

  return { text, meta };
}

async function callGeminiGenerateContent(
  apiKey: string,
  model: string,
  parts: GeminiPart[],
  maxTokens: number,
  jsonMode: boolean,
  preferredAuth?: GeminiAuthMode,
  cachedContentName?: string,
): Promise<GenerationResult> {
  const resolvedParts = await resolvePartsForGenerateContent(parts);
  try {
    return await postGenerateContent(
      apiKey,
      model,
      resolvedParts,
      maxTokens,
      jsonMode,
      true,
      preferredAuth,
      cachedContentName,
    );
  } catch (e) {
    const err = e as GeminiCallError;
    if (!isConfigRejection(err)) throw err;
    const fallbackTokens = inflatedTokenBudget(maxTokens);
    console.warn(
      `[Gemini] thinking control rejected for ${model} on generateContent; ` +
        `retrying without thinking fields at maxOutputTokens=${fallbackTokens}`,
    );
    return postGenerateContent(
      apiKey,
      model,
      resolvedParts,
      fallbackTokens,
      jsonMode,
      false,
      preferredAuth,
      cachedContentName,
    );
  }
}

/**
 * Unified text generation for one model: generateContent auth modes, then Interactions.
 * AQ keys prefer Interactions first for text-only (generateContent often 404s).
 * When cachedContentName is set, only generateContent is used (Interactions has no cachedContents).
 */
async function generateTextWithModel(
  apiKey: string,
  model: string,
  parts: GeminiPart[],
  maxTokens: number,
  jsonMode: boolean,
  preferredAuth?: GeminiAuthMode,
  cachedContentName?: string,
): Promise<GenerationResult> {
  const multimodal = hasMultimodalInput(parts);
  const aqKey = isAuthKey(apiKey);
  const attempts: Array<'interactions' | 'generateContent'> = cachedContentName
    ? ['generateContent']
    : aqKey || preferredAuth === 'interactions'
      ? ['interactions', 'generateContent']
      : ['generateContent', 'interactions'];

  let lastError: GeminiCallError | null = null;
  /** A 200 with no text is far more diagnostic than the 404 the other route will return. */
  let emptyOutputError: GeminiCallError | null = null;

  for (const route of attempts) {
    try {
      if (route === 'interactions') {
        const result = await callGeminiInteractions(apiKey, model, parts, maxTokens, jsonMode, preferredAuth);
        console.info(`[Gemini] interactions ok for ${model}${multimodal ? ' (multimodal)' : ''}`);
        return result;
      }

      const result = await callGeminiGenerateContent(
        apiKey,
        model,
        parts,
        maxTokens,
        jsonMode,
        preferredAuth,
        cachedContentName,
      );
      return result;
    } catch (e) {
      lastError = e as GeminiCallError;
      if (lastError.status === 401 || lastError.status === 403 || lastError.status === 429) {
        throw lastError;
      }
      if (lastError.status === 200) emptyOutputError = lastError;
      console.info(
        `[Gemini] ${route} failed for ${model} (${lastError.status ?? 'unknown'}): ${lastError.message}`,
      );
    }
  }

  throw emptyOutputError ?? lastError ?? new Error(`All routes failed for ${model}`);
}

async function callGeminiModel(
  apiKey: string,
  model: string,
  parts: GeminiPart[],
  maxTokens = DEFAULT_MAX_TOKENS,
  jsonMode = true,
  cachedContentName?: string,
): Promise<GenerationResult> {
  const prefs = await loadGeminiPrefs();
  const result = await generateTextWithModel(
    apiKey,
    model,
    parts,
    maxTokens,
    jsonMode,
    prefs.authMode,
    cachedContentName,
  );
  await persistGeminiPrefs(model, result.meta.authMode);
  return result;
}

let activeModel: string = GEMINI_MODELS[0];
/** Models confirmed via ListModels for the current key (preference order). */
let cachedModelOrder: string[] | null = null;
let cachedModelOrderKey = '';

/** All flash-capable models from ListModels — not restricted to GEMINI_MODELS constant. */
export async function discoverModels(apiKey: string): Promise<string[]> {
  const prefs = await loadGeminiPrefs();
  const modes = headerAuthModes(apiKey, prefs.authMode);

  const { response } = await geminiFetchWithAuth(
    apiKey,
    BASE_URL,
    { method: 'GET' },
    modes,
    'ListModels',
    true,
  );

  if (!response.ok) return [];

  const data = (await response.json()) as { models?: ListModelEntry[] };
  const flashModels: string[] = [];

  for (const entry of data.models ?? []) {
    const shortName = shortModelName(entry.name);
    if (!shortName || !isFlashModel(shortName)) continue;
    if ((RETIRED_GEMINI_MODELS as readonly string[]).includes(shortName)) continue;
    if (!modelSupportsGeneration(entry)) continue;
    flashModels.push(shortName);
  }

  return sortModelsByPreference(flashModels);
}

/** @deprecated Use discoverModels — kept for internal compatibility. */
async function listAvailableFlashModels(apiKey: string): Promise<string[]> {
  return discoverModels(apiKey);
}

async function resolveModelOrder(apiKey: string): Promise<string[]> {
  // Options pin wins: no silent cascade to slower models (honest A/B latency tests).
  const settings = await getSettings();
  const pinned = settings.geminiModel?.trim();
  if (pinned) {
    activeModel = pinned;
    const prefs = await loadGeminiPrefs();
    if (prefs.model !== pinned) {
      await chrome.storage.local.set({ preferredGeminiModel: pinned });
    }
    cachedModelOrder = [pinned];
    cachedModelOrderKey = apiKey;
    return [pinned];
  }

  if (cachedModelOrder && cachedModelOrderKey === apiKey) {
    return cachedModelOrder;
  }

  const stored = await loadStoredDiscoveredModels();
  const prefs = await loadGeminiPrefs();
  const cacheFresh =
    stored != null && Date.now() - stored.at < DISCOVERED_MODELS_TTL_MS;

  let discovered: string[];
  if (cacheFresh) {
    discovered = sortModelsByPreference(stored.models);
  } else {
    discovered = await listAvailableFlashModels(apiKey);
    if (discovered.length === 0 && stored != null) {
      discovered = sortModelsByPreference(stored.models);
    }
    if (discovered.length > 0) {
      await persistDiscoveredModels(discovered);
    }
  }

  const order =
    discovered.length > 0
      ? prefs.model && discovered.includes(prefs.model)
        ? [prefs.model, ...discovered.filter((m) => m !== prefs.model)]
        : discovered
      : prefs.model
        ? [prefs.model, ...GEMINI_MODELS.filter((m) => m !== prefs.model)]
        : [activeModel, ...GEMINI_MODELS.filter((m) => m !== activeModel)];

  cachedModelOrder = order;
  cachedModelOrderKey = apiKey;
  return order;
}

/** Drop in-memory discovery so the next call re-reads settings / ListModels. */
export function clearGeminiModelOrderCache(): void {
  cachedModelOrder = null;
  cachedModelOrderKey = '';
}

export function getActiveGeminiModel(): string {
  return activeModel;
}

function formatLastError(lastError: GeminiCallError | null, discovered: string[]): string {
  if (lastError?.message && !lastError.message.includes('Trying next model')) {
    const status = lastError.status ? ` [HTTP ${lastError.status}${lastError.route ? ` on ${lastError.route}` : ''}]` : '';
    const detail = `${lastError.message}${status}`;
    if (discovered.length > 0) {
      return `${detail} (tried: ${discovered.join(', ')})`;
    }
    return detail;
  }

  const parsed = lastError?.rawBody ? parseErrorBody(lastError.rawBody) : null;
  const apiMsg = parsed?.error?.message;
  if (apiMsg) {
    return discovered.length > 0
      ? `${apiMsg} (models listed: ${discovered.join(', ')})`
      : apiMsg;
  }

  if (discovered.length === 0) {
    return 'ListModels returned no flash models for this key. Check billing in Google AI Studio.';
  }

  return `Gemini request failed for all models (${discovered.join(', ')}). Check billing in Google AI Studio and reload the extension.`;
}

async function callGemini(
  apiKey: string,
  parts: GeminiPart[],
  maxTokens = DEFAULT_MAX_TOKENS,
  jsonMode = true,
  stage: UsageStage = 'other',
): Promise<GenerationResult> {
  const deadline = Date.now() + COMPOSE_WALL_CLOCK_MS;
  const discovered = await resolveModelOrder(apiKey);
  const models = [
    ...(discovered.includes(activeModel) ? [activeModel] : []),
    ...discovered.filter((m) => m !== activeModel),
    // When a model is pinned via settings, resolveModelOrder is length-1 — do not append fallbacks.
    ...(discovered.length === 1
      ? []
      : GEMINI_MODELS.filter((m) => !discovered.includes(m) && m !== activeModel)),
  ];

  let lastError: GeminiCallError | null = null;

  for (const model of models) {
    if (Date.now() > deadline) {
      throw new Error(
        `Compose wall-clock budget (${COMPOSE_WALL_CLOCK_MS}ms) exceeded before trying ${model}. ` +
          (lastError ? formatLastError(lastError, discovered) : 'No model response yet.'),
      );
    }
    try {
      const result = await callGeminiModel(apiKey, model, parts, maxTokens, jsonMode);
      activeModel = model;
      await trackGenerationUsage(result, stage);
      return result;
    } catch (e) {
      lastError = e as GeminiCallError;
      if (lastError.status === 401 || lastError.status === 403) throw lastError;
      if (lastError.status === 429) throw lastError;
      // Pinned single-model: surface the error instead of cascading.
      if (discovered.length === 1) break;
    }
  }

  throw new Error(formatLastError(lastError, discovered));
}

async function trackGenerationUsage(result: GenerationResult, stage: UsageStage): Promise<void> {
  const tokens = parseUsagePayload(result.meta.usage);
  if (
    tokens.inputTokens === 0 &&
    tokens.outputTokens === 0 &&
    tokens.thinkingTokens === 0 &&
    tokens.cachedInputTokens === 0
  ) {
    return;
  }
  try {
    await recordUsage({
      model: result.meta.model,
      stage,
      ...tokens,
    });
  } catch (e) {
    console.warn('[Gemini] usage ledger write failed', e);
  }
}

function formatModelLabel(model: string): string {
  return model.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ');
}

function authModeLabel(mode: GeminiAuthMode): string {
  switch (mode) {
    case 'query-key':
      return '?key=';
    case 'x-goog-api-key':
      return 'x-goog-api-key header';
    case 'bearer':
      return 'Authorization: Bearer';
    case 'interactions':
      return 'Interactions API';
  }
}

/** Validate API key — performs a real generation via the same path as compose. */
export async function validateApiKey(
  apiKey: string,
  preferredModel?: string,
): Promise<ApiKeyValidation> {
  const trimmed = apiKey.trim();
  if (!isGeminiKeyFormat(trimmed)) {
    return {
      valid: false,
      message: 'Key should start with AIza... or AQ.... (from aistudio.google.com/apikey).',
    };
  }

  cachedModelOrder = null;
  cachedModelOrderKey = '';

  const prefs = await loadGeminiPrefs();
  const settings = await getSettings();
  const pinned = preferredModel?.trim() || settings.geminiModel?.trim() || prefs.model;
  const discovered = await discoverModels(trimmed);

  if (discovered.length > 0) {
    await persistDiscoveredModels(discovered);
  }

  // When the user pinned a model in Options, validate that model only.
  const modelsToTry = pinned
    ? [pinned]
    : discovered.length > 0
      ? prefs.model && discovered.includes(prefs.model)
        ? [prefs.model, ...discovered.filter((m) => m !== prefs.model)]
        : discovered
      : prefs.model
        ? [prefs.model, ...GEMINI_MODELS.filter((m) => m !== prefs.model)]
        : [...GEMINI_MODELS];

  cachedModelOrder = modelsToTry;
  cachedModelOrderKey = trimmed;

  let lastError: GeminiCallError | null = null;

  for (const model of modelsToTry) {
    try {
      // Not 4 tokens: a thinking model can spend a tiny budget entirely on thoughts and
      // return nothing, which would read as an invalid key.
      const result = await callGeminiModel(
        trimmed,
        model,
        [{ text: 'Reply with the word ok.' }],
        256,
        false,
      );
      activeModel = model;
      await trackGenerationUsage(result, 'validate');

      const stored = await loadGeminiPrefs();
      const authHint = stored.authMode ? ` via ${authModeLabel(stored.authMode)}` : '';

      return {
        valid: true,
        message: `Key valid ✓ (${formatModelLabel(model)}${authHint})`,
        model,
      };
    } catch (e) {
      const err = e as GeminiCallError & { name?: string };
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return {
          valid: false,
          message: 'Gemini API timed out. Check your network and try again.',
        };
      }
      if (err.status === 429) {
        activeModel = model;
        const stored = await loadGeminiPrefs();
        const authHint = stored.authMode ? ` via ${authModeLabel(stored.authMode)}` : '';
        return {
          valid: true,
          message: `Key valid ✓ (${formatModelLabel(model)}${authHint}, rate limited right now)`,
          warning: 'Google returned 429 Too Many Requests. Wait 60 seconds before generating replies.',
          model,
        };
      }
      if (err.status === 401 || err.status === 403) {
        return { valid: false, message: err.message };
      }
      lastError = err;
    }
  }

  return {
    valid: false,
    message: pinned
      ? `Pinned model ${pinned} is not available on this key. ${formatLastError(lastError, discovered)}`
      : formatLastError(lastError, discovered),
  };
}

/** Fetch image bytes from pbs.twimg.com (CORS-friendly from extension SW). */
async function fetchImageAsBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
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
    return { mimeType, data };
  } catch {
    return null;
  }
}

async function describeOneMediaItem(apiKey: string, item: MediaItem): Promise<string> {
  if (item.altText) {
    mediaDebug('using alt text for media', { type: item.type, altLen: item.altText.length });
    return item.altText;
  }
  if (!item.url) return fallbackDescriptionForMedia(item);

  const describePrompt = visionPromptForMedia(item);
  mediaDebug('vision describe via interactions/generateContent', {
    type: item.type,
    url: item.url,
  });

  try {
    return (
      await callGemini(
        apiKey,
        [{ text: describePrompt }, { imageUri: item.url, imageMimeType: 'image/webp' }],
        VISION_MAX_TOKENS,
        false,
        'vision',
      )
    ).text.trim();
  } catch (e) {
    mediaDebug('vision via URI failed, trying inline fetch', e);
    const imageData = await fetchImageAsBase64(item.url);
    if (!imageData) return fallbackDescriptionForMedia(item);
    try {
      return (
        await callGemini(
          apiKey,
          [{ text: describePrompt }, { inlineData: imageData }],
          VISION_MAX_TOKENS,
          false,
          'vision',
        )
      ).text.trim();
    } catch (inlineErr) {
      mediaDebug('vision via inline fetch failed', inlineErr);
      return fallbackDescriptionForMedia(item);
    }
  }
}

/** Stage 1: multimodal comprehend — cached by tweet ID in session storage. */
export async function comprehendPost(apiKey: string, postBrief: PostBrief): Promise<ComprehendResult> {
  const totalVisual = postBrief.media.filter(
    (m) => m.type === 'photo' || m.type === 'video' || m.type === 'animated_gif',
  ).length;
  const toDescribe = selectMediaForDescription(postBrief.media);
  // Parallel vision calls — serialising up to 4 images would dominate the compose budget.
  const described = await Promise.all(
    toDescribe.map(async (item, index) => {
      const text = await describeOneMediaItem(apiKey, item);
      return text ? { index, text } : null;
    }),
  );
  const perItem = described.filter((d): d is { index: number; text: string } => d != null);

  let imageDescription = combineMediaDescriptions(perItem, totalVisual);
  if (!imageDescription && postBriefHasVisualMedia(postBrief)) {
    imageDescription = MEDIA_UNREADABLE;
  }

  mediaDebug('comprehend imageDescription', {
    tweetId: postBrief.tweetId,
    mediaCount: totalVisual,
    described: perItem.length,
    len: imageDescription.length,
    preview: imageDescription.slice(0, 80),
  });

  const prompt = buildComprehendPrompt(postBrief, imageDescription);
  const { text: raw, meta } = await callGemini(
    apiKey,
    [{ text: prompt }],
    COMPREHEND_MAX_TOKENS,
    true,
    'comprehend',
  );
  const parsed = parseComprehendJson(raw);

  // Comprehend degrades to defaults on a parse miss, so this would otherwise fail invisibly.
  if (!parsed) {
    recordGenerationFailure({
      at: new Date().toISOString(),
      stage: 'comprehend',
      provider: 'gemini',
      ...metaForDebug(meta),
      rawLength: raw.length,
      rawPreview: raw.slice(0, RAW_PREVIEW_CHARS),
      error: 'Comprehend JSON unparseable — falling back to post text',
    });
  }

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
    // F10: do not let a parse-failure fallback poison the session cache.
    degraded: !parsed,
  };
}

function metaForDebug(meta: GenerationMeta) {
  return {
    model: meta.model,
    route: meta.route,
    authMode: meta.authMode,
    httpStatus: meta.httpStatus,
    interactionStatus: meta.interactionStatus,
    finishReason: meta.finishReason,
    safety: meta.safety,
    usage: meta.usage,
    truncated: meta.truncated,
    maxOutputTokens: meta.maxOutputTokens,
  };
}

function composeFailureMessage(raw: string, meta: GenerationMeta, truncated: boolean): string {
  const where = `${meta.model} via ${meta.route}`;
  if (!raw.trim()) {
    return `${where} returned an empty response. Open the service worker console (chrome://extensions → "service worker") for the full payload.`;
  }
  if (truncated) {
    return `${where} was cut off before it finished writing (hit its ${meta.maxOutputTokens}-token output limit). Retry, or use the Shorter chip.`;
  }
  return `${where} replied, but nothing usable could be read out of it. The raw response is in the service worker console.`;
}

/** Stage 2: text-only compose with verbalized sampling k=5. */
export async function composeReplies(apiKey: string, req: ComposeRequest): Promise<VerbalizedCandidate[]> {
  const prefix = buildComposeCachePrefix(req);
  const suffix = buildComposeDynamicSuffix(req);
  const prompt = buildComposePrompt(req);

  const models = await resolveModelOrder(apiKey);
  const model = models[0] ?? activeModel;

  let result: GenerationResult | null = null;
  let usedCache = false;

  try {
    const cache = await ensureComposeCache(apiKey, model, prefix);
    if (cache) {
      try {
        result = await callGeminiModel(
          apiKey,
          model,
          [{ text: suffix }],
          COMPOSE_MAX_TOKENS,
          false,
          cache.name,
        );
        activeModel = model;
        await trackGenerationUsage(result, 'compose');
        usedCache = true;
        console.info(`[Gemini] compose via cachedContent ${cache.name}`);
      } catch (cacheErr) {
        console.warn('[Gemini] cached compose failed; falling back to full prompt', cacheErr);
      }
    }
  } catch (e) {
    console.info('[Gemini cache] ensureComposeCache threw; using full prompt', e);
  }

  if (!result) {
    // jsonMode off: free-form output plus layered parsing tolerates every shape the model returns.
    result = await callGemini(apiKey, [{ text: prompt }], COMPOSE_MAX_TOKENS, false, 'compose');
  }

  const { text: raw, meta } = result;
  const parsed = parseCandidatesWithDiagnostics(raw);

  const debugBase = {
    at: new Date().toISOString(),
    stage: 'compose' as const,
    provider: 'gemini' as const,
    ...metaForDebug(meta),
    parseStrategy: parsed.strategy,
    promptChars: prompt.length,
    rawLength: raw.length,
    rawPreview: raw.slice(0, RAW_PREVIEW_CHARS),
    error: usedCache ? 'compose used createCachedContent prefix' : undefined,
  };

  if (parsed.candidates.length === 0) {
    const truncated = meta.truncated || parsed.truncated;
    recordGenerationFailure({
      ...debugBase,
      truncated,
      error: 'No candidates recovered from model response',
    });
    throw new Error(composeFailureMessage(raw, meta, truncated));
  }

  if (parsed.strategy !== 'strict-json') {
    recordGenerationRecovery({
      ...debugBase,
      error: `recovered ${parsed.candidates.length} via ${parsed.strategy}`,
    });
  } else if (usedCache) {
    recordGenerationRecovery({
      ...debugBase,
      error: 'compose used createCachedContent prefix',
    });
  }

  return parsed.candidates;
}
