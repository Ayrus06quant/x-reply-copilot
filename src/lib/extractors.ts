import type { GraphQLMedia, GraphQLTweetResult } from '../types/graphql';
import type { PostAuthor, PostBrief, PostMedia, PostReply } from '../types/post';

function getUserHandle(result: GraphQLTweetResult): string {
  const user = result.core?.user_results?.result;
  return (
    user?.legacy?.screen_name ??
    user?.core?.screen_name ??
    'unknown'
  );
}

function getUserName(result: GraphQLTweetResult): string {
  const user = result.core?.user_results?.result;
  return user?.legacy?.name ?? user?.core?.name ?? getUserHandle(result);
}

function getUserId(result: GraphQLTweetResult): string {
  return result.core?.user_results?.result?.rest_id ?? '';
}

function getTweetText(result: GraphQLTweetResult): string {
  return (
    result.note_tweet?.note_tweet_results?.result?.text ??
    result.legacy?.full_text ??
    ''
  );
}

function unwrapTweet(raw: unknown): GraphQLTweetResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.__typename === 'TweetWithVisibilityResults') {
    return (obj.tweet as GraphQLTweetResult) ?? null;
  }
  if (obj.tweet) return obj.tweet as GraphQLTweetResult;
  if (obj.legacy || obj.rest_id) return obj as GraphQLTweetResult;
  return null;
}

/** Media extraction: ext_alt_text first, pbs.twimg.com webp small with medium escalation. */
export function extractMedia(result: GraphQLTweetResult): PostMedia[] {
  const mediaList =
    result.legacy?.extended_entities?.media ??
    result.extended_entities?.media ??
    result.legacy?.entities?.media ??
    [];

  return mediaList.map((m: GraphQLMedia) => {
    const type = (m.type ?? 'photo') as PostMedia['type'];
    const baseUrl = m.media_url_https ?? '';
    const largeW = m.sizes?.large?.w ?? 0;
    const text = getTweetText(result);
    const name =
      largeW > 1500 && !text.trim() ? 'medium' : 'small';
    const url = baseUrl
      ? `${baseUrl.split('?')[0]}?format=webp&name=${name}`
      : '';

    const item: PostMedia = {
      type: type === 'video' || type === 'animated_gif' ? type : 'photo',
      url,
      altText: m.ext_alt_text?.alt_text,
      width: m.sizes?.large?.w,
      height: m.sizes?.large?.w,
    };

    if (type === 'video' || type === 'animated_gif') {
      item.posterUrl = baseUrl ? `${baseUrl.split('?')[0]}?format=webp&name=small` : undefined;
    }

    return item;
  });
}

export function tweetToPostBrief(
  result: GraphQLTweetResult,
  topReplies: PostReply[] = [],
): PostBrief | null {
  const id = result.rest_id ?? '';
  const text = getTweetText(result);
  if (!id || !text) return null;

  const author: PostAuthor = {
    id: getUserId(result),
    handle: getUserHandle(result),
    displayName: getUserName(result),
  };

  return {
    id,
    text,
    author,
    media: extractMedia(result),
    topReplies: topReplies.slice(0, 10),
    url: `https://x.com/${author.handle}/status/${id}`,
    capturedAt: Date.now(),
  };
}

export function extractRepliesFromInstructions(
  instructions: Array<{ entries?: Array<{ content?: { itemContent?: { tweet_results?: { result?: unknown } } } }> }> | undefined,
  excludeId?: string,
): PostReply[] {
  const replies: PostReply[] = [];
  for (const instr of instructions ?? []) {
    for (const entry of instr.entries ?? []) {
      const raw = entry.content?.itemContent?.tweet_results?.result;
      const tweet = unwrapTweet(raw);
      if (!tweet?.rest_id || tweet.rest_id === excludeId) continue;
      const replyText = getTweetText(tweet);
      if (!replyText) continue;
      replies.push({
        id: tweet.rest_id,
        text: replyText,
        authorHandle: getUserHandle(tweet),
      });
    }
  }
  return replies;
}

export function extractTweetsFromInstructions(
  instructions: Array<{ entries?: Array<{ content?: { itemContent?: { tweet_results?: { result?: unknown } } } }> }> | undefined,
): GraphQLTweetResult[] {
  const tweets: GraphQLTweetResult[] = [];
  for (const instr of instructions ?? []) {
    for (const entry of instr.entries ?? []) {
      const raw = entry.content?.itemContent?.tweet_results?.result;
      const tweet = unwrapTweet(raw);
      if (tweet?.rest_id) tweets.push(tweet);
    }
  }
  return tweets;
}

export { unwrapTweet, getTweetText, getUserHandle, getUserId };
