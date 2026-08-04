import {
  extractOperationName,
  extractViewerHandle,
  extractViewerUserId,
  isComposeOperation,
  isGraphQLUrl,
  isHarvestOperation,
  isProfileTimelineRequest,
  parseCreateTweet,
  parseGraphQLResponse,
} from '../lib/graphql-parser';
import { buildPostBrief, extractOwnReplies } from '../lib/post-brief';
import { harvestDebug } from '../lib/debug';
import type { AllowedOperation, InterceptorMessage } from '../lib/types';

const CHANNEL = 'x-reply-copilot';

const nativeFetch = window.fetch.bind(window);
const nativeToString = Function.prototype.toString.call(nativeFetch);

type XrcWindow = Window & {
  __XRC_OWN_HANDLE?: string;
  __XRC_OWN_USER_ID?: string;
};

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

function postToExtension(msg: InterceptorMessage): void {
  window.postMessage({ source: CHANNEL, ...msg }, '*');
}

function tryHarvestReplies(data: unknown, operation: AllowedOperation, operationName: string | null): void {
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
    postToExtension({ type: 'graphql', operation, payload: { harvest: replies } });
  }
}

async function handleGraphQLResponse(
  url: string,
  init: RequestInit | undefined,
  response: Response,
): Promise<void> {
  const operationName = extractOperationName(url, init);
  const data = await parseGraphQLResponse(response);
  if (!data) return;

  const viewerHandle = extractViewerHandle(data);
  if (viewerHandle) setOwnHandle(viewerHandle);

  const viewerUserId = extractViewerUserId(data);
  if (viewerUserId) setOwnUserId(viewerUserId);

  const operation = (operationName ?? 'ProfileTimeline') as AllowedOperation;

  if (operationName === 'CreateTweet') {
    const created = parseCreateTweet(data);
    if (created) {
      postToExtension({ type: 'graphql', operation: 'CreateTweet', payload: created });
    }
    return;
  }

  if (isComposeOperation(operationName)) {
    const brief = buildPostBrief(operationName, data);
    if (brief) {
      postToExtension({ type: 'graphql', operation: operationName, payload: brief });
    }
    return;
  }

  const shouldHarvest =
    isHarvestOperation(operationName) ||
    (!operationName && isProfileTimelineRequest(url, init));

  if (shouldHarvest) {
    tryHarvestReplies(data, operation, operationName);
  } else {
    harvestDebug('skip harvest — operation not eligible', { operation: operationName, url: url.slice(0, 120) });
  }
}

function patchFetch(): void {
  const proxy = new Proxy(nativeFetch, {
    apply(target, thisArg, args: [RequestInfo | URL, RequestInit?]) {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      const result = Reflect.apply(target, thisArg, args) as Promise<Response>;

      if (isGraphQLUrl(url)) {
        result
          .then((response) => handleGraphQLResponse(url, init, response))
          .catch(() => {
            /* ignore */
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
        try {
          if (xhr.responseType && xhr.responseType !== 'text') return;
          const text = xhr.responseText;
          if (!text) return;

          const data = JSON.parse(text) as unknown;
          const init = body && typeof body === 'string' ? { body } : undefined;
          const operationName = extractOperationName(url, init);

          const viewerHandle = extractViewerHandle(data);
          if (viewerHandle) setOwnHandle(viewerHandle);

          const viewerUserId = extractViewerUserId(data);
          if (viewerUserId) setOwnUserId(viewerUserId);

          if (operationName === 'CreateTweet') {
            const created = parseCreateTweet(data);
            if (created) {
              postToExtension({ type: 'graphql', operation: 'CreateTweet', payload: created });
            }
            return;
          }

          if (isComposeOperation(operationName)) {
            const brief = buildPostBrief(operationName, data);
            if (brief) {
              postToExtension({ type: 'graphql', operation: operationName, payload: brief });
            }
            return;
          }

          const shouldHarvest =
            isHarvestOperation(operationName) ||
            (!operationName && isProfileTimelineRequest(url, init));

          if (shouldHarvest) {
            tryHarvestReplies(data, (operationName ?? 'ProfileTimeline') as AllowedOperation, operationName);
          }
        } catch {
          /* ignore malformed responses */
        }
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

function listenForOwnHandle(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.data?.source !== CHANNEL) return;
    if (event.data?.type === 'set_own_handle' && typeof event.data.handle === 'string') {
      setOwnHandle(event.data.handle);
    }
    if (event.data?.type === 'set_own_user_id' && typeof event.data.userId === 'string') {
      setOwnUserId(event.data.userId);
    }
  });

  seedHandleFromProfileUrl();
}

export default defineUnlistedScript(() => {
  harvestDebug('interceptor installed', window.location.pathname);
  listenForOwnHandle();
  patchFetch();
  patchXHR();
});
