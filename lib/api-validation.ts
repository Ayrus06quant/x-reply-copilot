import type { Provider } from './types';
import { validateApiKey as validateGeminiKey } from './gemini';
import { validateApiKey as validateGroqKey } from './groq';

export interface ApiKeyValidation {
  valid: boolean;
  message: string;
  warning?: string;
  model?: string;
}

/** Validate an API key for the selected provider — callable from Options page without service worker. */
export async function validateApiKeyForProvider(
  provider: Provider,
  apiKey: string,
): Promise<ApiKeyValidation> {
  if (provider === 'groq') return validateGroqKey(apiKey);
  return validateGeminiKey(apiKey);
}
