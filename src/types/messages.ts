import type { PostBrief, RefinementModifier, Suggestion } from './post';
import type { StyleCard, UserConditioning } from './style';

export type ExtensionMessage =
  | { type: 'POST_OPENED'; post: PostBrief }
  | { type: 'REPLY_CLICKED'; postId: string }
  | { type: 'COMPOSER_CLOSED' }
  | { type: 'CREATE_TWEET'; text: string; inReplyTo?: string; suggestionId?: string }
  | { type: 'CORPUS_HARVEST'; payload: unknown; ownUserId: string }
  | { type: 'CORPUS_REPLY'; text: string; id: string; authorId: string; ownUserId: string }
  | { type: 'CLIPBOARD_WRITE'; text: string }
  | { type: 'VALIDATE_API_KEY'; apiKey: string }
  | { type: 'SAVE_SETTINGS'; settings: Partial<StoredSettings & { conditioning?: UserConditioning; styleCard?: StyleCard }> }
  | { type: 'REGENERATE_STYLE_CARD' }
  | { type: 'GET_SUGGESTIONS'; postId: string }
  | { type: 'REFINE'; postId: string; modifier: RefinementModifier }
  | { type: 'INSERT_SUGGESTION'; index: number }
  | { type: 'GET_GOVERNOR_STATUS' }
  | { type: 'GET_STYLE_CARD' }
  | { type: 'PREFETCH_COMPOSE'; postId: string };

export type ExtensionResponse =
  | { type: 'SUGGESTIONS'; suggestions: Suggestion[]; reading: boolean }
  | { type: 'SUGGESTIONS_ERROR'; error: string }
  | { type: 'GOVERNOR_STATUS'; dailyUsed: number; dailyBudget: number; accountNudges: Record<string, number> }
  | { type: 'STYLE_CARD'; card: StyleCard; conditioning: UserConditioning }
  | { type: 'READING_INDICATOR'; active: boolean };

export interface StoredSettings {
  geminiApiKey?: string;
  ownUserId?: string;
  ownHandle?: string;
  dailyBudget?: number;
  onboardingComplete?: boolean;
  disclosureAccepted?: boolean;
}
