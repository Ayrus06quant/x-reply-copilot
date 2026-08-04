import type { ComprehendResult, ComposeRequest, PostBrief, VerbalizedCandidate } from './types';
import type { ApiKeyValidation } from './api-validation';
import * as gemini from './gemini';
import * as groq from './groq';

export interface AiProviderModule {
  validateApiKey(apiKey: string): Promise<ApiKeyValidation>;
  comprehendPost(apiKey: string, postBrief: PostBrief): Promise<ComprehendResult>;
  composeReplies(apiKey: string, req: ComposeRequest): Promise<VerbalizedCandidate[]>;
}

const providers: Record<'gemini' | 'groq', AiProviderModule> = {
  gemini,
  groq,
};

export function getAiProvider(provider: 'gemini' | 'groq'): AiProviderModule {
  return providers[provider];
}
