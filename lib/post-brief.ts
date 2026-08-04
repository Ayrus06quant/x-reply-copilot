import {
  dig,
  extractTimelineEntries,
  extractTweetId,
  extractTweetText,
  extractUserHandle,
  extractUserId,
  extractUserName,
  getTweetFromEntry,
  unwrapTweet,
} from './graphql-parser';
import { extractMediaFromTweet } from './media';
import type { AllowedOperation, PostBrief, ReplySnippet } from './types';

function extractRepliesFromConversation(data: unknown, limit = 10): ReplySnippet[] {
  const entries = extractTimelineEntries(data);
  const replies: ReplySnippet[] = [];

  for (const entry of entries) {
    if (replies.length >= limit) break;

    const tweet = getTweetFromEntry(entry);
    if (!tweet) continue;

    const text = extractTweetText(tweet);
    if (!text) continue;

    const handle = extractUserHandle(tweet);
    const likeCount = dig<number>(tweet, 'legacy', 'favorite_count') ?? 0;

    replies.push({ handle, text, likeCount });
  }

  return replies.sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0));
}

function extractPrimaryTweet(data: unknown): unknown | null {
  const threaded =
    dig(data, 'data', 'threaded_conversation_with_injections_v2', 'instructions') ??
    dig(data, 'data', 'tweetDetail', 'instructions');

  if (threaded) {
    const entries = extractTimelineEntries({ data: { threaded_conversation_with_injections_v2: { instructions: threaded } } });
    for (const entry of entries) {
      const tweet = getTweetFromEntry(entry);
      if (tweet && extractTweetText(tweet)) return tweet;
    }
  }

  const entries = extractTimelineEntries(data);
  for (const entry of entries) {
    const tweet = getTweetFromEntry(entry);
    if (tweet && extractTweetText(tweet)) return tweet;
  }

  return null;
}

/** Merge incoming brief with existing — keep richer media/replies when DOM overwrites GraphQL. */
export function mergePostBrief(existing: PostBrief | null, incoming: PostBrief): PostBrief {
  if (!existing || existing.tweetId !== incoming.tweetId) return incoming;

  return {
    ...incoming,
    text: incoming.text.trim() || existing.text,
    media: incoming.media.length > 0 ? incoming.media : existing.media,
    topReplies: incoming.topReplies.length > 0 ? incoming.topReplies : existing.topReplies,
    authorHandle: incoming.authorHandle || existing.authorHandle,
    authorName: incoming.authorName || existing.authorName,
    createdAt: incoming.createdAt ?? existing.createdAt,
    url: incoming.url ?? existing.url,
  };
}

export function postBriefHasVisualMedia(brief: PostBrief): boolean {
  return brief.media.some((m) => m.type === 'photo' || m.type === 'animated_gif' || m.type === 'video');
}

/** Build slim PostBrief from GraphQL payload — defensive ?? throughout. */
export function buildPostBrief(operation: AllowedOperation, data: unknown): PostBrief | null {
  if (!data || typeof data !== 'object') return null;

  let tweet: unknown = null;
  let topReplies: ReplySnippet[] = [];

  switch (operation) {
    case 'TweetDetail': {
      tweet = extractPrimaryTweet(data);
      topReplies = extractRepliesFromConversation(data, 10);
      break;
    }
    case 'HomeTimeline':
    case 'UserTweetsAndReplies': {
      const entries = extractTimelineEntries(data);
      for (const entry of entries) {
        const t = getTweetFromEntry(entry);
        if (t && extractTweetText(t)) {
          tweet = t;
          break;
        }
      }
      break;
    }
    case 'CreateTweet':
      return null;
  }

  if (!tweet) return null;

  const tweetId = extractTweetId(tweet);
  if (!tweetId) return null;

  const text = extractTweetText(tweet);
  const authorHandle = extractUserHandle(tweet);
  const authorName = extractUserName(tweet);
  const media = extractMediaFromTweet(tweet);
  const createdAt = dig<string>(tweet, 'legacy', 'created_at') ?? undefined;

  return {
    tweetId,
    authorHandle,
    authorName,
    text,
    createdAt,
    media,
    topReplies: topReplies.filter((r) => r.handle !== authorHandle).slice(0, 10),
    url: `https://x.com/${authorHandle}/status/${tweetId}`,
  };
}

/** Extract user's own replies from profile timeline GraphQL for corpus harvest. */
export function extractOwnReplies(
  data: unknown,
  ownHandle: string,
  options?: {
    ownUserId?: string;
    operation?: string | null;
    onProfileRepliesTab?: boolean;
  },
): Array<{ text: string; handle: string }> {
  const results: Array<{ text: string; handle: string }> = [];
  const entries = extractTimelineEntries(data);
  const operation = options?.operation ?? null;
  const relaxedReplyCheck =
    options?.onProfileRepliesTab === true ||
    /Replies|TweetsAndReplies|ProfileTweets/i.test(operation ?? '');

  for (const entry of entries) {
    const tweet = unwrapTweet(getTweetFromEntry(entry));
    if (!tweet) continue;

    const handle = extractUserHandle(tweet);
    const tweetUserId = extractUserId(tweet);
    const isOwn =
      (options?.ownUserId && tweetUserId === options.ownUserId) ||
      handle.toLowerCase() === ownHandle.toLowerCase();
    if (!isOwn) continue;

    const inReplyTo =
      dig<string>(tweet, 'legacy', 'in_reply_to_status_id_str') ??
      dig<string>(tweet, 'legacy', 'in_reply_to_status_id');
    const inReplyToUser =
      dig<string>(tweet, 'legacy', 'in_reply_to_user_id_str') ??
      dig<string>(tweet, 'legacy', 'in_reply_to_user_id');

    if (!relaxedReplyCheck && !inReplyTo && !inReplyToUser) continue;

    const text = extractTweetText(tweet);
    if (text) results.push({ text, handle });
  }

  return results;
}
