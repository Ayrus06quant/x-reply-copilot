import { COMPOSE_OPERATIONS, HARVEST_OPERATIONS } from './types';
import type { ComposeOperation, HarvestOperation } from './types';

/**
 * P2: one allowlist, derived from the declared constants rather than restated here.
 * The previous runtime definition was a hardcoded Set plus a broad regex, and it had
 * already drifted from `lib/types.ts` (F20). A regex is also not "an explicit
 * operation-name allowlist", which is the wording the privacy claim rests on (I6).
 *
 * P1: these are OPERATION NAMES. The rotating `<queryId>` hash never appears here and
 * must never be matched on — X regenerates it on essentially every frontend deploy.
 */
const COMPOSE_OPS: ReadonlySet<string> = new Set<string>(COMPOSE_OPERATIONS);
const HARVEST_OPS: ReadonlySet<string> = new Set<string>(HARVEST_OPERATIONS);

/**
 * P4: operations that may never be read through the structural fallback, whatever their
 * request variables look like. The `https://x.com/*` host permission grants access to
 * DMs and drafts; this is the veto that keeps a shape heuristic from ever reaching them.
 */
const DENIED_NAME_RE =
  /\b(dm|direct_?message|conversation|draft|notification|settings|bookmark|mute|block|password|email|phone|payment|subscription|card_?private|typeahead)/i;

/** True when URL targets X's GraphQL API. */
export function isGraphQLUrl(url: string): boolean {
  return url.includes('/i/api/graphql/');
}

/** Extract GraphQL operation name from X API URL path, query, or POST body. */
export function extractOperationName(url: string, init?: RequestInit): string | null {
  try {
    const parsed = new URL(url, 'https://x.com');

    // Path: /i/api/graphql/{hash}/{OperationName}
    const pathMatch = parsed.pathname.match(/\/i\/api\/graphql\/[^/]+\/([^/?]+)/);
    if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);

    const fromQuery = parsed.searchParams.get('operationName');
    if (fromQuery) return fromQuery;

    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as { operationName?: string };
        return body.operationName ?? null;
      } catch {
        // not JSON
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/** Parse GraphQL variables from query string or POST body. */
export function extractGraphQLVariables(
  url: string,
  init?: RequestInit,
): Record<string, unknown> | null {
  try {
    const parsed = new URL(url, 'https://x.com');
    const fromQuery = parsed.searchParams.get('variables');
    if (fromQuery) {
      return JSON.parse(fromQuery) as Record<string, unknown>;
    }

    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as { variables?: Record<string, unknown> };
        return body.variables ?? null;
      } catch {
        // not JSON
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function isComposeOperation(name: string | null): name is ComposeOperation {
  return !!name && COMPOSE_OPS.has(name);
}

export function isHarvestOperation(name: string | null): name is HarvestOperation {
  if (!name) return false;
  if (COMPOSE_OPS.has(name)) return false;
  return HARVEST_OPS.has(name);
}

/**
 * P4: a hard veto on the structural fallback. Matches on the operation NAME only, so it
 * costs nothing and runs before any body is touched.
 */
export function isDeniedOperation(name: string | null): boolean {
  return !!name && DENIED_NAME_RE.test(name);
}

/**
 * P4 structural fallback: recognises a tweet-detail request from its *variables*, not its
 * name, so a renamed operation still works. Reads no response body — this decides whether
 * the body may be read at all.
 */
export function isTweetDetailRequest(url: string, init?: RequestInit): boolean {
  const variables = extractGraphQLVariables(url, init);
  if (!variables) return false;
  return (
    typeof variables.focalTweetId === 'string' ||
    typeof variables.focalTweetId === 'number' ||
    typeof variables.tweetId === 'string' ||
    typeof variables.tweetId === 'number'
  );
}

/** Profile timelines include userId in variables — used when the operation name rotates. */
export function isProfileTimelineRequest(url: string, init?: RequestInit): boolean {
  const operation = extractOperationName(url, init);
  if (operation && isHarvestOperation(operation)) return true;

  const variables = extractGraphQLVariables(url, init);
  if (!variables) return false;
  return typeof variables.userId === 'string' || typeof variables.userId === 'number';
}

/**
 * P4: second gate on the structural path. Confirms a payload is actually tweet-shaped
 * before anything is extracted from it, so a request that merely carried a `userId`
 * variable cannot smuggle a non-timeline payload through.
 */
export function looksLikeTweetPayload(data: unknown): boolean {
  if (!dig<Record<string, unknown>>(data, 'data')) return false;
  if (
    dig(data, 'data', 'threaded_conversation_with_injections_v2') ??
    dig(data, 'data', 'tweetDetail') ??
    dig(data, 'data', 'tweetResult') ??
    dig(data, 'data', 'home', 'home_timeline_urt')
  ) {
    return true;
  }
  const userTimeline =
    dig(data, 'data', 'user', 'result', 'timeline_v2') ??
    dig(data, 'data', 'user', 'result', 'timeline') ??
    dig(data, 'data', 'user', 'result', 'profile_timeline_v2') ??
    dig(data, 'data', 'user', 'result', 'profile_timeline');
  if (userTimeline) return true;

  return extractTimelineEntries(data).length > 0;
}

/** Safely parse JSON response from fetch clone. */
export async function parseGraphQLResponse(response: Response): Promise<unknown> {
  try {
    const clone = response.clone();
    return await clone.json();
  } catch {
    return null;
  }
}

/** Walk nested GraphQL result paths defensively. */
export function dig<T>(obj: unknown, ...keys: string[]): T | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as T | undefined;
}

function collectEntriesFromInstructions(instructions: unknown[]): unknown[] {
  const entries: unknown[] = [];
  for (const instruction of instructions) {
    const type = dig<string>(instruction, 'type');
    if (type === 'TimelineAddEntries') {
      const addEntries = dig<unknown[]>(instruction, 'entries') ?? [];
      entries.push(...addEntries);
    }
    if (type === 'TimelinePinEntry') {
      const pin = dig<unknown>(instruction, 'entry');
      if (pin) entries.push(pin);
    }
  }
  return entries;
}

function findTimelineInstructionsDeep(obj: unknown, depth = 0): unknown[] {
  if (depth > 12 || obj == null) return [];
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj.every((item) => dig<string>(item, 'type')?.startsWith('Timeline'))) {
      return obj;
    }
    for (const item of obj) {
      const found = findTimelineInstructionsDeep(item, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  }
  if (typeof obj === 'object') {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      const found = findTimelineInstructionsDeep(value, depth + 1);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/** Extract tweet results array from various timeline instruction shapes. */
export function extractTimelineEntries(data: unknown): unknown[] {
  const instructions =
    dig<unknown[]>(data, 'data', 'home', 'home_timeline_urt', 'instructions') ??
    dig<unknown[]>(data, 'data', 'user', 'result', 'timeline_v2', 'timeline', 'instructions') ??
    dig<unknown[]>(data, 'data', 'user', 'result', 'timeline', 'timeline', 'instructions') ??
    dig<unknown[]>(data, 'data', 'user', 'result', 'profile_timeline_v2', 'timeline', 'instructions') ??
    dig<unknown[]>(data, 'data', 'user', 'result', 'profile_timeline', 'timeline', 'instructions') ??
    dig<unknown[]>(data, 'data', 'threaded_conversation_with_injections_v2', 'instructions') ??
    findTimelineInstructionsDeep(data);

  return collectEntriesFromInstructions(instructions);
}

/** Unwrap TweetWithVisibilityResults and similar wrappers to the inner tweet. */
export function unwrapTweet(raw: unknown): unknown | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const typename = obj.__typename as string | undefined;

  if (typename === 'TweetWithVisibilityResults' || typename === 'TweetWithVisibilityResultsType') {
    return unwrapTweet(obj.tweet);
  }
  if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') return null;
  if (obj.tweet && typeof obj.tweet === 'object') return unwrapTweet(obj.tweet);
  if (obj.legacy || obj.rest_id || obj.core) return raw;
  return null;
}

/**
 * Expand one timeline entry into zero or more tweet results.
 *
 * TweetDetail nests replies under `TimelineTimelineModule` / `conversationthread-*`
 * entries (`content.items[].item.itemContent`), not as flat `TimelineTimelineItem`s.
 * Reading only `content.itemContent` yields the focal tweet (and its media) while
 * silently dropping every reply — the live `topReplies: 0` failure mode.
 */
export function getTweetsFromEntry(entry: unknown): unknown[] {
  const flatRaw =
    dig(entry, 'content', 'itemContent', 'tweet_results', 'result') ??
    dig(entry, 'content', 'itemContent', 'tweetResult', 'result') ??
    dig(entry, 'item', 'itemContent', 'tweet_results', 'result') ??
    dig(entry, 'content', 'content', 'tweetResult', 'result', 'result');
  const flat = unwrapTweet(flatRaw);
  if (flat) return [flat];

  const items = dig<unknown[]>(entry, 'content', 'items');
  if (!items?.length) return [];

  const tweets: unknown[] = [];
  for (const item of items) {
    const itemRaw =
      dig(item, 'item', 'itemContent', 'tweet_results', 'result') ??
      dig(item, 'item', 'itemContent', 'tweetResult', 'result') ??
      dig(item, 'itemContent', 'tweet_results', 'result') ??
      dig(item, 'itemContent', 'tweetResult', 'result');
    const tweet = unwrapTweet(itemRaw);
    if (tweet) tweets.push(tweet);
  }
  return tweets;
}

/** First tweet result from a timeline entry, or null. */
export function getTweetFromEntry(entry: unknown): unknown {
  return getTweetsFromEntry(entry)[0] ?? null;
}

/** Extract full text from legacy or note_tweet. */
export function extractTweetText(tweet: unknown): string {
  const unwrapped = unwrapTweet(tweet) ?? tweet;
  const noteText = dig<string>(unwrapped, 'note_tweet', 'note_tweet_results', 'result', 'text');
  if (noteText) return noteText;

  const legacyText = dig<string>(unwrapped, 'legacy', 'full_text');
  return legacyText ?? '';
}

export function extractTweetId(tweet: unknown): string | undefined {
  return (
    dig<string>(tweet, 'rest_id') ??
    dig<string>(tweet, 'legacy', 'id_str') ??
    dig<string>(tweet, 'id')
  );
}

export function extractUserHandle(tweet: unknown): string {
  const unwrapped = unwrapTweet(tweet) ?? tweet;
  const legacy = dig<{ screen_name?: string }>(unwrapped, 'legacy');
  const core = dig<{ user_results?: { result?: { legacy?: { screen_name?: string }; core?: { screen_name?: string } } } }>(
    unwrapped,
    'core',
  );
  return (
    legacy?.screen_name ??
    core?.user_results?.result?.legacy?.screen_name ??
    core?.user_results?.result?.core?.screen_name ??
    dig<string>(unwrapped, 'core', 'user_results', 'result', 'legacy', 'screen_name') ??
    dig<string>(unwrapped, 'core', 'user_results', 'result', 'core', 'screen_name') ??
    'unknown'
  );
}

export function extractUserId(tweet: unknown): string | undefined {
  const unwrapped = unwrapTweet(tweet) ?? tweet;
  return (
    dig<string>(unwrapped, 'core', 'user_results', 'result', 'rest_id') ??
    dig<string>(unwrapped, 'legacy', 'user_id_str') ??
    dig<string>(unwrapped, 'legacy', 'user_id')
  );
}

export function extractUserName(tweet: unknown): string {
  return (
    dig<string>(tweet, 'core', 'user_results', 'result', 'legacy', 'name') ??
    dig<string>(tweet, 'legacy', 'name') ??
    ''
  );
}

export function extractMediaEntities(tweet: unknown): unknown[] {
  return (
    dig<unknown[]>(tweet, 'legacy', 'extended_entities', 'media') ??
    dig<unknown[]>(tweet, 'legacy', 'entities', 'media') ??
    []
  );
}

/** Parse CreateTweet response for posted text. */
export function parseCreateTweet(data: unknown): {
  fullText: string;
  tweetId?: string;
  inReplyTo?: string;
  /** Screen name of the account being replied to — governor keys by handle (F2). */
  inReplyToHandle?: string;
} | null {
  const raw =
    dig(data, 'data', 'create_tweet', 'tweet_results', 'result') ??
    dig(data, 'data', 'notetweet_create', 'tweet_results', 'result');
  const result = unwrapTweet(raw);

  if (!result) return null;

  const text = extractTweetText(result);
  const tweetId = extractTweetId(result);
  const inReplyTo =
    dig<string>(result, 'legacy', 'in_reply_to_status_id_str') ??
    dig<string>(result, 'legacy', 'in_reply_to_status_id');
  const inReplyToHandle = dig<string>(result, 'legacy', 'in_reply_to_screen_name') ?? undefined;

  if (!text) return null;
  return {
    fullText: text,
    tweetId,
    inReplyTo: inReplyTo ?? undefined,
    inReplyToHandle,
  };
}

/** Try to read logged-in user's handle from Viewer / account GraphQL payloads. */
export function extractViewerHandle(data: unknown): string | null {
  const candidates = [
    dig<string>(data, 'data', 'viewer', 'user_results', 'result', 'legacy', 'screen_name'),
    dig<string>(data, 'data', 'viewer', 'user_results', 'result', 'core', 'screen_name'),
    dig<string>(data, 'data', 'viewer_v2', 'user_results', 'result', 'legacy', 'screen_name'),
    dig<string>(data, 'data', 'viewer_v2', 'user_results', 'result', 'core', 'screen_name'),
    dig<string>(data, 'data', 'user', 'result', 'legacy', 'screen_name'),
    dig<string>(data, 'data', 'user', 'result', 'core', 'screen_name'),
    dig<string>(data, 'data', 'user', 'result', 'core', 'screen_name'),
  ];
  for (const handle of candidates) {
    if (handle) return handle;
  }
  return null;
}

/** Try to read logged-in user's numeric ID from Viewer GraphQL payloads. */
export function extractViewerUserId(data: unknown): string | null {
  const candidates = [
    dig<string>(data, 'data', 'viewer', 'user_results', 'result', 'rest_id'),
    dig<string>(data, 'data', 'viewer_v2', 'user_results', 'result', 'rest_id'),
    dig<string>(data, 'data', 'user', 'result', 'rest_id'),
  ];
  for (const id of candidates) {
    if (id) return id;
  }
  return null;
}
