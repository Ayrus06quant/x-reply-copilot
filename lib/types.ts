import type { PipelineTiming } from './perf';

/** Slim post context extracted from GraphQL — kept small for postMessage. */
export interface PostBrief {
  tweetId: string;
  authorHandle: string;
  authorName: string;
  text: string;
  createdAt?: string;
  media: MediaItem[];
  topReplies: ReplySnippet[];
  url?: string;
  /**
   * Which path produced this brief. P6 requires degradation to the DOM scrape to be
   * visible, so nobody mistakes a thin brief for a model-quality problem again.
   */
  source?: 'graphql' | 'dom';
}

export interface MediaItem {
  type: 'photo' | 'video' | 'animated_gif';
  url: string;
  altText?: string;
  width?: number;
  height?: number;
  videoVariants?: VideoVariant[];
}

export interface VideoVariant {
  url: string;
  contentType: string;
  bitrate?: number;
}

export interface ReplySnippet {
  handle: string;
  text: string;
  likeCount?: number;
}

/** Measured voice profile derived from user's reply corpus. */
export interface StyleCard {
  medianWordCount: number;
  wordCountP25: number;
  wordCountP75: number;
  contractionRate: number;
  lowercaseOpenerRate: number;
  emojiRate: number;
  exclamationRate: number;
  openers: string[];
  closers: string[];
  signaturePhrases: string[];
  bannedPatterns: string[];
  sampleHandle?: string;
  corpusSize: number;
  updatedAt: number;
}

export interface Suggestion {
  text: string;
  intent: 'Add' | 'Ask' | 'Push back';
  probability?: number;
  rank?: number;
}

export interface VerbalizedCandidate {
  text: string;
  intent: 'Add' | 'Ask' | 'Push back';
  probability: number;
}

export interface Conditioning {
  knownFor?: string;
  neverMention?: string;
  defaultIntent?: 'Add' | 'Ask' | 'Push back';
}

export type Provider = 'gemini' | 'groq';

export interface UserSettings {
  apiKey?: string;
  apiProvider?: Provider;
  conditioning: Conditioning;
  onboardingComplete: boolean;
  dailyReplyBudget: number;
  accountNudgeThreshold: number;
  /** When false (default), passive GraphQL reply harvesting is skipped. Manual paste still works. */
  harvestEnabled?: boolean;
}

export interface ComprehendResult {
  claim: string;
  tone: string;
  domain: string;
  entities: string[];
  imageDescription: string;
  repliesAlreadySaid: string[];
  tweetId: string;
  cachedAt: number;
  /** True when Stage 1 JSON parse failed and fields are fallbacks (F10). */
  degraded?: boolean;
}

export interface ComposeRequest {
  postBrief: PostBrief;
  comprehend: ComprehendResult;
  styleCard: StyleCard;
  exemplars: string[];
  conditioning: Conditioning;
  refinement?: RefinementChip;
  username: string;
}

export type RefinementChip =
  | 'shorter'
  | 'sharper'
  | 'funnier'
  | 'less_agreeable'
  | 'add_question';

export interface PostedReplyDiff {
  tweetId: string;
  suggestionText: string;
  postedText: string;
  suggestionIndex: number;
  timestamp: number;
  /** Raw Levenshtein distance between suggestion and posted text (F4 / flywheel). */
  editDistance?: number;
  /** `editDistance / max(len(suggestion), len(posted), 1)`. */
  normalizedEditDistance?: number;
}

export interface GovernorState {
  date: string;
  replyCount: number;
  accountCounts: Record<string, number>;
}

/** GraphQL operation names we intercept for compose / post briefs. */
export const COMPOSE_OPERATIONS = [
  'TweetDetail',
  'HomeTimeline',
  'CreateTweet',
] as const;

/** Profile timeline operations that may contain the user's own replies for harvest. */
export const HARVEST_OPERATIONS = [
  'UserTweetsAndReplies',
  'UserTweets',
  'UserWithProfileTweetsAndReplies',
  'ProfileTimeline',
  'UserMedia',
] as const;

export const ALLOWED_OPERATIONS = [
  ...COMPOSE_OPERATIONS,
  ...HARVEST_OPERATIONS,
] as const;

export type ComposeOperation = (typeof COMPOSE_OPERATIONS)[number];
export type HarvestOperation = (typeof HARVEST_OPERATIONS)[number];
export type AllowedOperation = (typeof ALLOWED_OPERATIONS)[number];

export interface InterceptorGraphQLMessage {
  type: 'graphql';
  /** Operation name exactly as X sent it. Never a queryId hash (P1). */
  operation: string;
  /** The name was unrecognised and the request variables authorised the read (P4). */
  structural?: boolean;
  payload: unknown;
}

/**
 * P5: silent breakage is forbidden. Every classification the interceptor makes is
 * reported so a disappeared operation surfaces instead of producing nothing for weeks.
 */
export interface GraphqlHealthEvent {
  kind: 'hit' | 'structural' | 'drop';
  operation: string | null;
  route: 'compose' | 'create' | 'harvest' | 'drop';
  reason?: string;
}

export interface InterceptorTelemetryMessage {
  type: 'graphql_telemetry';
  payload: GraphqlHealthEvent;
}

export type InterceptorMessage = InterceptorGraphQLMessage | InterceptorTelemetryMessage;

export interface CreateTweetPayload {
  tweetId?: string;
  fullText: string;
  inReplyToStatusId?: string;
}

/** Extension message types between content script and service worker. */
export type ExtensionMessage =
  | { type: 'COMPREHEND'; postBrief: PostBrief }
  | { type: 'COMPOSE'; postBrief: PostBrief; refinement?: RefinementChip }
  | { type: 'GET_SUGGESTIONS'; tweetId: string }
  | { type: 'VALIDATE_API_KEY'; apiKey: string; provider?: Provider }
  /** A whole intercepted batch in one message — one round trip per response, not per reply. */
  | { type: 'HARVEST_REPLY'; replies: Array<{ text: string; handle: string }> }
  | { type: 'IMPORT_MANUAL_REPLIES'; text: string; handle: string }
  | { type: 'GET_CORPUS_COUNT' }
  | { type: 'RECORD_POST'; diff: PostedReplyDiff; targetHandle?: string }
  | { type: 'GET_STYLE_CARD' }
  | { type: 'GET_GOVERNOR_STATUS'; targetHandle: string }
  | { type: 'GET_LAST_STYLE_REGEN' }
  | { type: 'PING' };

export type ExtensionResponse =
  | {
      ok: true;
      suggestions?: Suggestion[];
      comprehend?: ComprehendResult;
      styleCard?: StyleCard;
      governor?: GovernorStatus;
      valid?: boolean;
      validationMessage?: string;
      validationWarning?: string;
      validationModel?: string;
      corpusCount?: number;
      added?: number;
      /** Stage timings measured in the service worker; see lib/perf.ts. */
      timing?: PipelineTiming;
      /** Visible before/after when the flywheel regenerates the StyleCard (~50 posts). */
      styleRegen?: StyleCardRegenSnapshot;
    }
  | { ok: false; error: string };

/** Persisted / messaged before/after from a ~50-post StyleCard regeneration. */
export interface StyleCardRegenSnapshot {
  at: number;
  previous: StyleCard;
  current: StyleCard;
  summary: string;
  postedDiffCount: number;
}

export interface GovernorStatus {
  remainingBudget: number;
  accountReplyCount: number;
  nudge?: string;
  blocked?: boolean;
}

export interface CachedSuggestions {
  tweetId: string;
  suggestions: Suggestion[];
  timestamp: number;
}
