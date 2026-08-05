const HARVEST_DEBUG_KEY = 'xrc_debug_harvest';
const MEDIA_DEBUG_KEY = 'xrc_debug_media';

/** Service workers have no localStorage — mirror the flags into extension storage. */
const storageFlags: Record<string, boolean> = {};

try {
  chrome.storage?.local
    ?.get([HARVEST_DEBUG_KEY, MEDIA_DEBUG_KEY])
    .then((result) => {
      storageFlags[HARVEST_DEBUG_KEY] = result[HARVEST_DEBUG_KEY] === true;
      storageFlags[MEDIA_DEBUG_KEY] = result[MEDIA_DEBUG_KEY] === true;
    })
    .catch(() => {
      /* page realm has no chrome.storage — debug flags fall back to localStorage */
    });
} catch {
  /* not in an extension context */
}

function isDebugFlagEnabled(key: string, windowFlag: string): boolean {
  if (storageFlags[key]) return true;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1') {
      return true;
    }
    if (typeof window !== 'undefined') {
      return !!(window as unknown as Record<string, boolean | undefined>)[windowFlag];
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Enable harvest debug logs on x.com: localStorage.setItem('xrc_debug_harvest', '1') */
export function isHarvestDebugEnabled(): boolean {
  return isDebugFlagEnabled(HARVEST_DEBUG_KEY, '__XRC_DEBUG_HARVEST');
}

/** Enable media/vision debug logs: localStorage.setItem('xrc_debug_media', '1') */
export function isMediaDebugEnabled(): boolean {
  return isDebugFlagEnabled(MEDIA_DEBUG_KEY, '__XRC_DEBUG_MEDIA');
}

export function harvestDebug(...args: unknown[]): void {
  if (isHarvestDebugEnabled()) {
    console.log('[XRC Harvest]', ...args);
  }
}

export function mediaDebug(...args: unknown[]): void {
  if (isMediaDebugEnabled()) {
    console.log('[XRC Media]', ...args);
  }
}

/** Read the last failure with: chrome.storage.local.get('xrcLastGenerationDebug', console.log) */
export const LAST_GENERATION_DEBUG_KEY = 'xrcLastGenerationDebug';

export const RAW_PREVIEW_CHARS = 2000;

export interface GenerationDebugRecord {
  at: string;
  stage: 'compose' | 'comprehend' | 'validate';
  provider: 'gemini' | 'groq';
  model?: string;
  route?: string;
  authMode?: string;
  httpStatus?: number;
  /** Interactions API interaction.status — "incomplete" means it hit max_output_tokens. */
  interactionStatus?: string;
  finishReason?: string;
  safety?: unknown;
  usage?: unknown;
  truncated?: boolean;
  parseStrategy?: string;
  promptChars?: number;
  maxOutputTokens?: number;
  rawLength?: number;
  rawPreview?: string;
  error?: string;
}

/** Always logs — a generation failure the user can see is the whole point. */
export function recordGenerationFailure(record: GenerationDebugRecord): void {
  console.error('[XRC Generation] FAILED', record);
  try {
    chrome.storage?.local
      ?.set({ [LAST_GENERATION_DEBUG_KEY]: record })
      .catch((e: unknown) => console.warn('[XRC Generation] could not persist record', e));
  } catch {
    /* storage unavailable — console log already emitted */
  }
}

/** Logs when a fallback strategy rescued a malformed response, so silent degradation is visible. */
export function recordGenerationRecovery(record: GenerationDebugRecord): void {
  console.warn('[XRC Generation] recovered via fallback parsing', record);
  try {
    chrome.storage?.local
      ?.set({ [LAST_GENERATION_DEBUG_KEY]: record })
      .catch((e: unknown) => console.warn('[XRC Generation] could not persist record', e));
  } catch {
    /* ignore */
  }
}
