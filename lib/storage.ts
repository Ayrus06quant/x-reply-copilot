import type { UserSettings } from './types';

const STORAGE_KEY = 'x_reply_copilot_settings';

const DEFAULT_SETTINGS: UserSettings = {
  apiProvider: 'gemini',
  conditioning: {},
  onboardingComplete: false,
  dailyReplyBudget: 50,
  accountNudgeThreshold: 4,
  harvestEnabled: false,
};

export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] as UserSettings | undefined;
  return { ...DEFAULT_SETTINGS, ...stored, conditioning: { ...DEFAULT_SETTINGS.conditioning, ...stored?.conditioning } };
}

export async function saveSettings(partial: Partial<UserSettings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...current, ...partial, conditioning: { ...current.conditioning, ...partial.conditioning } },
  });
}

export async function getApiKey(): Promise<string | undefined> {
  const settings = await getSettings();
  return settings.apiKey;
}

export async function setApiKey(apiKey: string): Promise<void> {
  await saveSettings({ apiKey });
}

export async function clearApiKey(): Promise<void> {
  const settings = await getSettings();
  const { apiKey: _, ...rest } = settings;
  await chrome.storage.local.set({ [STORAGE_KEY]: rest });
}

/** Session cache for Comprehend results keyed by tweet ID. */
export async function getSessionCache<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.session.get(key);
  return result[key] as T | undefined;
}

export async function setSessionCache(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function getCachedSuggestions(tweetId: string) {
  return getSessionCache<{ suggestions: unknown[]; timestamp: number }>(`suggestions:${tweetId}`);
}

export async function setCachedSuggestions(tweetId: string, suggestions: unknown[]): Promise<void> {
  await setSessionCache(`suggestions:${tweetId}`, { suggestions, timestamp: Date.now() });
}

export async function getLastServedSuggestion(tweetId: string): Promise<{ text: string; index: number } | undefined> {
  return getSessionCache(`served:${tweetId}`);
}

export async function setLastServedSuggestion(tweetId: string, text: string, index: number): Promise<void> {
  await setSessionCache(`served:${tweetId}`, { text, index });
}
