/**
 * Explicit Gemini context cache for the stable compose prefix (plan 2A).
 * SW / Options only — never imported from the content script (I4).
 */

export const COMPOSE_CACHE_STORAGE_KEY = 'xrcComposeCache';

const CACHED_CONTENTS_URL = 'https://generativelanguage.googleapis.com/v1beta/cachedContents';
const DEFAULT_TTL = '3600s';

export interface ComposeCacheRecord {
  name: string;
  fingerprint: string;
  model: string;
  expireTime: number;
  tokenCount?: number;
}

export type GeminiCacheAuthMode = 'query-key' | 'x-goog-api-key' | 'bearer';

function applyAuth(
  url: string,
  apiKey: string,
  mode: GeminiCacheAuthMode,
  init: RequestInit,
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
    'Content-Type': 'application/json',
  };
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
  }
}

function authModes(apiKey: string): GeminiCacheAuthMode[] {
  return apiKey.startsWith('AQ.')
    ? ['x-goog-api-key', 'query-key', 'bearer']
    : ['query-key', 'x-goog-api-key'];
}

async function fetchWithAuth(
  apiKey: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let last: Response | null = null;
  for (const mode of authModes(apiKey)) {
    const { url: u, init: i } = applyAuth(url, apiKey, mode, init);
    const response = await fetch(u, { ...i, signal: AbortSignal.timeout(25_000) });
    last = response;
    if (response.ok || (response.status !== 401 && response.status !== 403 && response.status !== 404)) {
      return response;
    }
  }
  return last!;
}

/** FNV-1a 32-bit — good enough for cache fingerprinting, no crypto dependency. */
export function fingerprintPrefix(model: string, prefix: string): string {
  const input = `${model}\n${prefix}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export async function loadComposeCacheRecord(): Promise<ComposeCacheRecord | null> {
  const result = await chrome.storage.local.get(COMPOSE_CACHE_STORAGE_KEY);
  const rec = result[COMPOSE_CACHE_STORAGE_KEY] as ComposeCacheRecord | undefined;
  if (!rec?.name || !rec.fingerprint || !rec.model) return null;
  if (typeof rec.expireTime === 'number' && Date.now() >= rec.expireTime - 60_000) {
    return null;
  }
  return rec;
}

export async function clearComposeCacheRecord(): Promise<void> {
  await chrome.storage.local.remove(COMPOSE_CACHE_STORAGE_KEY);
}

/**
 * Ensure a cachedContents resource exists for this model+prefix.
 * Returns null when the API rejects (under min tokens, unsupported, etc.) — caller falls back.
 */
export async function ensureComposeCache(
  apiKey: string,
  model: string,
  prefix: string,
): Promise<ComposeCacheRecord | null> {
  const fingerprint = fingerprintPrefix(model, prefix);
  const existing = await loadComposeCacheRecord();
  if (
    existing &&
    existing.fingerprint === fingerprint &&
    existing.model === model &&
    Date.now() < existing.expireTime - 60_000
  ) {
    return existing;
  }

  if (existing?.name) {
    try {
      await deleteCachedContent(apiKey, existing.name);
    } catch {
      /* best-effort delete */
    }
  }

  const body = {
    model: model.startsWith('models/') ? model : `models/${model}`,
    displayName: `xrc-compose-${fingerprint.slice(0, 8)}`,
    ttl: DEFAULT_TTL,
    systemInstruction: {
      parts: [{ text: prefix }],
    },
  };

  const response = await fetchWithAuth(apiKey, CACHED_CONTENTS_URL, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    const lower = errText.toLowerCase();
    if (
      lower.includes('min') ||
      lower.includes('token') ||
      lower.includes('too short') ||
      lower.includes('minimum')
    ) {
      console.info(
        `[Gemini cache] skipped for ${model}: under min tokens or rejected (${response.status}). ` +
          `Falling back to full-prompt compose.`,
      );
    } else {
      console.warn(`[Gemini cache] createCachedContent failed (${response.status}): ${errText.slice(0, 300)}`);
    }
    await clearComposeCacheRecord();
    return null;
  }

  const data = (await response.json()) as {
    name?: string;
    expireTime?: string;
    usageMetadata?: { totalTokenCount?: number };
  };

  if (!data.name) {
    console.warn('[Gemini cache] createCachedContent returned no name');
    return null;
  }

  const expireTime = data.expireTime ? Date.parse(data.expireTime) : Date.now() + 3_600_000;
  const record: ComposeCacheRecord = {
    name: data.name,
    fingerprint,
    model,
    expireTime: Number.isFinite(expireTime) ? expireTime : Date.now() + 3_600_000,
    tokenCount: data.usageMetadata?.totalTokenCount,
  };
  await chrome.storage.local.set({ [COMPOSE_CACHE_STORAGE_KEY]: record });
  console.info(
    `[Gemini cache] created ${record.name} for ${model}` +
      (record.tokenCount != null ? ` (~${record.tokenCount} tokens)` : ''),
  );
  return record;
}

async function deleteCachedContent(apiKey: string, name: string): Promise<void> {
  const url = name.startsWith('http')
    ? name
    : `https://generativelanguage.googleapis.com/v1beta/${name.replace(/^\//, '')}`;
  await fetchWithAuth(apiKey, url, { method: 'DELETE', body: undefined });
}

/** Invalidate local + remote cache (model / style / conditioning change). */
export async function invalidateComposeCache(apiKey?: string): Promise<void> {
  const existing = await loadComposeCacheRecord();
  await clearComposeCacheRecord();
  if (apiKey && existing?.name) {
    try {
      await deleteCachedContent(apiKey, existing.name);
    } catch {
      /* best-effort */
    }
  }
}
