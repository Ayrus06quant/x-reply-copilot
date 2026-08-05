import {
  extractOperationName,
  extractViewerHandle,
  extractViewerUserId,
  isComposeOperation,
  isDeniedOperation,
  isGraphQLUrl,
  isHarvestOperation,
  isProfileTimelineRequest,
  isTweetDetailRequest,
  looksLikeTweetPayload,
  parseCreateTweet,
  parseGraphQLResponse,
} from '../lib/graphql-parser';
import { buildPostBrief, extractOwnReplies } from '../lib/post-brief';
import { harvestDebug } from '../lib/debug';
import { logEntry, logTiming, now, since } from '../lib/perf';
import type { GraphqlHealthEvent, InterceptorMessage } from '../lib/types';

const CHANNEL = 'x-reply-copilot';

/**
 * F8: set by the ISOLATED content script via `init_channel`. Until then outbound messages
 * omit the nonce (they sit in the replay buffer); after init, every post includes it and
 * inbound control messages without it are ignored.
 */
let channelNonce: string | null = null;

// Captured from the *unbound* original. `fetch.bind(window)` reports as an anonymous native
// function, so reading toString off the bound copy yields `function () { [native code] }`
// where a genuine fetch yields `function fetch() { [native code] }` — a one-character-class
// difference that a detection script can test for.
const nativeToString = Function.prototype.toString.call(window.fetch);
const nativeFetch = window.fetch.bind(window);

/**
 * `HomeTimeline` stays on the declared allowlist because the plan names it, but nothing
 * consumes it: `buildPostBrief` would pick an arbitrary first tweet out of a timeline page,
 * and comprehending one post per scroll batch multiplies API spend. Q1's recorded default
 * is prefetch on post-open only, so `TweetDetail` is the sole consumed compose operation.
 */
const CONSUMED_COMPOSE_OPS: ReadonlySet<string> = new Set(['TweetDetail']);

/** Messages produced before the ISOLATED content script exists are replayed on request. */
const REPLAY_LIMIT = 6;

type XrcWindow = Window & {
  __XRC_OWN_HANDLE?: string;
  __XRC_OWN_USER_ID?: string;
};

type RouteKind = 'compose' | 'create' | 'harvest' | 'drop';

interface Route {
  kind: RouteKind;
  operation: string | null;
  /** The operation name was unrecognised and the request variables authorised the read. */
  structural: boolean;
  reason: string;
}

const replayBuffer: InterceptorMessage[] = [];
const reportedDrops = new Set<string>();
const seenOperations = new Set<string>();

function getOwnHandle(): string | undefined {
  return (window as XrcWindow).__XRC_OWN_HANDLE;
}

function getOwnUserId(): string | undefined {
  return (window as XrcWindow).__XRC_OWN_USER_ID;
}

function setOwnHandle(handle: string): void {
  (window as XrcWindow).__XRC_OWN_HANDLE = handle;
  harvestDebug('own handle set', handle);
}

function setOwnUserId(userId: string): void {
  (window as XrcWindow).__XRC_OWN_USER_ID = userId;
  harvestDebug('own user id set', userId);
}

function isOnProfileRepliesTab(): boolean {
  return /\/with_replies\/?$/.test(window.location.pathname);
}

function envelope(msg: Record<string, unknown>): Record<string, unknown> {
  return channelNonce
    ? { source: CHANNEL, nonce: channelNonce, ...msg }
    : { source: CHANNEL, ...msg };
}

function postToExtension(msg: InterceptorMessage): void {
  if (msg.type === 'graphql') {
    replayBuffer.push(msg);
    if (replayBuffer.length > REPLAY_LIMIT) replayBuffer.shift();
  }
  window.postMessage(envelope({ ...msg }), '*');
}

/** P5: every classification is reported once so a data path can never go dark in silence. */
function reportHealth(event: GraphqlHealthEvent): void {
  if (event.kind === 'drop') {
    const dedupeKey = `${event.operation ?? 'unnamed'}:${event.reason ?? ''}`;
    if (reportedDrops.has(dedupeKey)) return;
    reportedDrops.add(dedupeKey);
  } else if (event.operation) {
    seenOperations.add(event.operation);
  }
  window.postMessage(envelope({ type: 'graphql_telemetry', payload: event }), '*');
}

/**
 * I6 / P3: the entire allowlist decision, made from the URL and request init alone. Nothing
 * here reads a response body. Everything this returns as `drop` is dropped before a single
 * byte of the body is deserialized.
 */
function classify(url: string, init: RequestInit | undefined): Route {
  const operation = extractOperationName(url, init);

  if (operation === 'CreateTweet') {
    return { kind: 'create', operation, structural: false, reason: 'allowlist' };
  }

  if (isComposeOperation(operation)) {
    return CONSUMED_COMPOSE_OPS.has(operation)
      ? { kind: 'compose', operation, structural: false, reason: 'allowlist' }
      : { kind: 'drop', operation, structural: false, reason: 'allowlisted-but-unconsumed' };
  }

  if (isHarvestOperation(operation)) {
    return { kind: 'harvest', operation, structural: false, reason: 'allowlist' };
  }

  // P4: the structural fallback only ever recognises payloads inside the already-permitted
  // set. It does not authorise a new URL, and a denied name vetoes it outright.
  if (isDeniedOperation(operation)) {
    return { kind: 'drop', operation, structural: false, reason: 'denied-operation' };
  }
  if (isTweetDetailRequest(url, init)) {
    return { kind: 'compose', operation, structural: true, reason: 'structural-focalTweetId' };
  }
  if (isProfileTimelineRequest(url, init)) {
    return { kind: 'harvest', operation, structural: true, reason: 'structural-userId' };
  }

  return {
    kind: 'drop',
    operation,
    structural: false,
    reason: operation ? 'not-allowlisted' : 'unnamed-operation',
  };
}

function tryHarvestReplies(data: unknown, operationName: string | null): void {
  const ownHandle = getOwnHandle();
  if (!ownHandle) {
    harvestDebug('skip harvest — no own handle', { operation: operationName });
    return;
  }

  const replies = extractOwnReplies(data, ownHandle, {
    ownUserId: getOwnUserId(),
    operation: operationName,
    onProfileRepliesTab: isOnProfileRepliesTab(),
  });

  harvestDebug('harvest scan', {
    operation: operationName,
    ownHandle,
    ownUserId: getOwnUserId(),
    onRepliesTab: isOnProfileRepliesTab(),
    found: replies.length,
  });

  if (replies.length > 0) {
    postToExtension({
      type: 'graphql',
      operation: operationName ?? 'ProfileTimeline',
      payload: { harvest: replies },
    });
  }
}

/**
 * Shared by the fetch and XHR paths. `readBody` is only ever called after the allowlist has
 * already said yes, which is the whole of I6.
 */
async function processGraphQL(
  url: string,
  init: RequestInit | undefined,
  readBody: () => Promise<unknown>,
): Promise<void> {
  const startedAt = now();
  const route = classify(url, init);

  if (route.kind === 'drop') {
    reportHealth({
      kind: 'drop',
      operation: route.operation,
      route: 'drop',
      reason: route.reason,
    });
    return;
  }

  const data = await readBody();
  if (!data) return;

  // Viewer identity is read only out of a payload we were already allowed to read. It used
  // to be swept out of every GraphQL response, allowlisted or not (F7).
  const viewerHandle = extractViewerHandle(data);
  if (viewerHandle) setOwnHandle(viewerHandle);
  const viewerUserId = extractViewerUserId(data);
  if (viewerUserId) setOwnUserId(viewerUserId);

  if (route.structural && !looksLikeTweetPayload(data)) {
    reportHealth({
      kind: 'drop',
      operation: route.operation,
      route: 'drop',
      reason: 'structural-shape-mismatch',
    });
    return;
  }

  reportHealth({
    kind: route.structural ? 'structural' : 'hit',
    operation: route.operation ?? route.reason,
    route: route.kind,
    reason: route.reason,
  });

  if (route.kind === 'create') {
    const created = parseCreateTweet(data);
    if (created) {
      postToExtension({ type: 'graphql', operation: 'CreateTweet', payload: created });
    }
    return;
  }

  if (route.kind === 'compose') {
    const brief = buildPostBrief('TweetDetail', data);
    if (brief) {
      postToExtension({
        type: 'graphql',
        operation: route.operation ?? 'TweetDetail',
        structural: route.structural,
        payload: { ...brief, source: 'graphql' as const },
      });
      logTiming('post open — brief extracted in MAIN world', {
        tweetId: brief.tweetId,
        topReplies: brief.topReplies.length,
        media: brief.media.length,
        structural: route.structural,
        ms: since(startedAt),
      });
    }
    return;
  }

  tryHarvestReplies(data, route.operation);
}

function patchFetch(): void {
  const proxy = new Proxy(nativeFetch, {
    apply(target, thisArg, args: [RequestInfo | URL, RequestInit?]) {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      const result = Reflect.apply(target, thisArg, args) as Promise<Response>;

      if (isGraphQLUrl(url)) {
        result
          .then((response) => processGraphQL(url, init, () => parseGraphQLResponse(response)))
          .catch(() => {
            /* never let extension work surface as a page-realm error (P7) */
          });
      }

      return result;
    },
  });

  window.fetch = proxy as typeof fetch;

  Function.prototype.toString = new Proxy(Function.prototype.toString, {
    apply(target, thisArg, args) {
      if (thisArg === window.fetch) {
        return nativeToString;
      }
      return Reflect.apply(target, thisArg, args) as string;
    },
  }) as typeof Function.prototype.toString;
}

function patchXHR(): void {
  const XHR = XMLHttpRequest;
  const open = XHR.prototype.open;
  const send = XHR.prototype.send;

  XHR.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    (this as XMLHttpRequest & { __xrcUrl?: string }).__xrcUrl =
      typeof url === 'string' ? url : url.href;
    return open.apply(this, [method, url, ...rest] as Parameters<typeof open>);
  };

  XHR.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const xhr = this as XMLHttpRequest & { __xrcUrl?: string };
    const url = xhr.__xrcUrl ?? '';

    if (isGraphQLUrl(url)) {
      xhr.addEventListener('load', () => {
        const init = body && typeof body === 'string' ? { body } : undefined;
        void processGraphQL(url, init, async () => {
          try {
            if (xhr.responseType && xhr.responseType !== 'text') return null;
            const text = xhr.responseText;
            if (!text) return null;
            return JSON.parse(text) as unknown;
          } catch {
            return null;
          }
        }).catch(() => {
          /* ignore — must never throw into X's own realm (P7) */
        });
      });
    }

    return send.apply(this, [body]);
  };
}

function seedHandleFromProfileUrl(): void {
  try {
    const path = window.location.pathname;
    const repliesMatch = path.match(/^\/([^/?#]+)\/with_replies\/?$/);
    if (repliesMatch?.[1]) {
      setOwnHandle(repliesMatch[1]);
      harvestDebug('seed handle from /with_replies URL', repliesMatch[1]);
      return;
    }

    const profileMatch = path.match(/^\/([^/?#]+)\/?$/);
    const reserved = new Set([
      'home',
      'explore',
      'notifications',
      'messages',
      'i',
      'settings',
      'search',
      'compose',
      'login',
      'signup',
    ]);
    const candidate = profileMatch?.[1];
    if (candidate && !reserved.has(candidate.toLowerCase())) {
      const existing = getOwnHandle();
      if (!existing) {
        setOwnHandle(candidate);
        harvestDebug('seed handle from profile URL (no prior handle)', candidate);
      }
    }
  } catch {
    /* ignore */
  }
}

function listenForContentScript(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.data?.source !== CHANNEL) return;

    // F8: content script establishes the shared nonce before any control messages are trusted.
    if (event.data?.type === 'init_channel' && typeof event.data.nonce === 'string') {
      channelNonce = event.data.nonce;
      return;
    }

    if (channelNonce && event.data?.nonce !== channelNonce) return;

    if (event.data?.type === 'set_own_handle' && typeof event.data.handle === 'string') {
      setOwnHandle(event.data.handle);
    }
    if (event.data?.type === 'set_own_user_id' && typeof event.data.userId === 'string') {
      setOwnUserId(event.data.userId);
    }
    // The ISOLATED content script starts at document_idle, long after this one. Anything
    // intercepted in between would otherwise be lost — which would take the post-open
    // prefetch with it on any direct load of a /status/ URL.
    if (event.data?.type === 'request_replay') {
      for (const buffered of replayBuffer) {
        window.postMessage(envelope({ ...buffered }), '*');
      }
      window.postMessage(
        envelope({
          type: 'graphql_telemetry',
          payload: {
            kind: 'hit',
            operation: 'interceptor_alive',
            route: 'compose',
            reason: `seen:${[...seenOperations].join('|') || 'none-yet'}`,
          } satisfies GraphqlHealthEvent,
        }),
        '*',
      );
    }
  });

  seedHandleFromProfileUrl();
}

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  // Keeps the bundle from declaring a named global on X's own page realm.
  globalName: false,
  main() {
    logEntry('interceptor — MAIN world, document_start', window.location.pathname);
    try {
      listenForContentScript();
      patchFetch();
      patchXHR();
      logEntry('interceptor — fetch and XHR patched');
    } catch (e) {
      console.error('[XRC Entry] interceptor failed to install', e);
    }
  },
});
