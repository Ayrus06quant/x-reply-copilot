import type { AllowedOperation } from '../types/graphql';
import { ALLOWED_OPERATIONS } from '../types/graphql';
import type { GraphQLTimelineData } from '../types/graphql';
import type { PostBrief } from '../types/post';
import {
  extractRepliesFromInstructions,
  extractTweetsFromInstructions,
  tweetToPostBrief,
  unwrapTweet,
  getTweetText,
  getUserId,
} from './extractors';

export const INTERCEPTOR_SOURCE = 'x-reply-copilot-interceptor';

export interface InterceptorMessage {
  source: typeof INTERCEPTOR_SOURCE;
  operation: AllowedOperation;
  payload: unknown;
}

function getOperationName(url: string): AllowedOperation | null {
  try {
    const u = new URL(url, location.origin);
    const op = u.pathname.split('/').pop()?.split('?')[0];
    if (op && (ALLOWED_OPERATIONS as readonly string[]).includes(op)) {
      return op as AllowedOperation;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractTweetDetail(data: GraphQLTimelineData, url: string): PostBrief | null {
  const result = unwrapTweet(data?.data?.tweetResult?.result);
  if (!result) return null;

  let topReplies = extractRepliesFromInstructions(
    data?.data?.tweetResult?.result
      ? undefined
      : undefined,
  );

  const threadInstructions =
    (data as Record<string, unknown>)?.threaded_conversation_with_injections_v2 as
      | { instructions?: Parameters<typeof extractRepliesFromInstructions>[0] }
      | undefined;

  if (threadInstructions?.instructions) {
    topReplies = extractRepliesFromInstructions(threadInstructions.instructions, result.rest_id);
  }

  const nested = data as Record<string, unknown>;
  const conversation =
    nested?.data &&
    typeof nested.data === 'object' &&
    (nested.data as Record<string, unknown>).threaded_conversation_with_injections_v2;
  if (conversation && typeof conversation === 'object') {
    const instr = (conversation as { instructions?: Parameters<typeof extractRepliesFromInstructions>[0] }).instructions;
    topReplies = extractRepliesFromInstructions(instr, result.rest_id);
  }

  return tweetToPostBrief(result, topReplies);
}

function extractFromTimeline(data: GraphQLTimelineData): PostBrief[] {
  const posts: PostBrief[] = [];
  const instructions =
    data?.data?.home?.home_timeline_urt?.instructions ??
    data?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
    data?.data?.user?.result?.timeline?.timeline?.instructions;

  const tweets = extractTweetsFromInstructions(instructions);
  for (const t of tweets) {
    const brief = tweetToPostBrief(t);
    if (brief) posts.push(brief);
  }
  return posts;
}

function extractCreateTweet(data: GraphQLTimelineData): { text: string; id: string } | null {
  const result = unwrapTweet(data?.data?.create_tweet?.tweet_results?.result);
  if (!result) return null;
  const text = getTweetText(result);
  const id = result.rest_id ?? '';
  if (!text || !id) return null;
  return { text, id };
}

function extractOwnReplies(
  data: GraphQLTimelineData,
  ownUserId: string,
): Array<{ id: string; text: string }> {
  const instructions =
    data?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
    data?.data?.user?.result?.timeline?.timeline?.instructions;

  const tweets = extractTweetsFromInstructions(instructions);
  return tweets
    .filter((t) => {
      const uid = getUserId(t);
      const isReply = !!t.legacy?.in_reply_to_status_id_str;
      return uid === ownUserId && isReply;
    })
    .map((t) => ({ id: t.rest_id ?? '', text: getTweetText(t) }))
    .filter((r) => r.id && r.text);
}

/** MAIN-world fetch interceptor — preserves native toString via ES6 Proxy */
export function installFetchInterceptor(): void {
  if ((window as unknown as Record<string, unknown>).__xReplyCopilotInstalled) return;
  (window as unknown as Record<string, unknown>).__xReplyCopilotInstalled = true;

  const nativeFetch = window.fetch.bind(window);

  const proxyHandler: ProxyHandler<typeof fetch> = {
    apply(target, thisArg, args: Parameters<typeof fetch>) {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const operation = getOperationName(url);

      const promise = Reflect.apply(target, thisArg, args) as ReturnType<typeof fetch>;

      if (!operation) return promise;

      return promise.then(async (response) => {
        try {
          const clone = response.clone();
          const data = (await clone.json()) as GraphQLTimelineData;

          const msg: InterceptorMessage = {
            source: INTERCEPTOR_SOURCE,
            operation,
            payload: data,
          };

          if (operation === 'TweetDetail') {
            const brief = extractTweetDetail(data, url);
            if (brief) {
              window.postMessage({ ...msg, postBrief: brief }, '*');
            }
          } else if (operation === 'HomeTimeline' || operation === 'UserTweetsAndReplies') {
            const posts = extractFromTimeline(data);
            window.postMessage({ ...msg, posts }, '*');
            if (operation === 'UserTweetsAndReplies') {
              window.postMessage({ ...msg, operation, corpusHint: true }, '*');
            }
          } else if (operation === 'CreateTweet') {
            const created = extractCreateTweet(data);
            if (created) {
              window.postMessage({ ...msg, createTweet: created }, '*');
            }
          } else {
            window.postMessage(msg, '*');
          }
        } catch {
          /* non-JSON or parse failure — ignore */
        }
        return response;
      });
    },
  };

  const proxiedFetch = new Proxy(nativeFetch, proxyHandler);

  Object.defineProperty(proxiedFetch, 'toString', {
    value: () => 'function fetch() { [native code] }',
    writable: false,
    configurable: true,
  });

  window.fetch = proxiedFetch;
}

export { extractOwnReplies, getOperationName };
