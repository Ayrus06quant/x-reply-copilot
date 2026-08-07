import './card.css';
import type { GraphqlHealthEvent, PostBrief, RefinementChip, Suggestion } from '../lib/types';
import {
  copyToClipboard,
  findComposer,
  focusComposer,
  insertIntoComposer,
  isComposerFocused,
} from '../lib/composer';
import { extractPostBriefFromTweetElement, findReplyTargetFromDom } from '../lib/dom-post-brief';
import { mergePostBrief, postBriefHasVisualMedia } from '../lib/post-brief';
import { sendExtensionMessage } from '../lib/messaging';
import { clearCachedSuggestions, setLastServedSuggestion } from '../lib/storage';
import { harvestDebug, mediaDebug } from '../lib/debug';
import { logEntry, logTiming, now, since } from '../lib/perf';

const CHANNEL = 'x-reply-copilot';
/** F8: required on every postMessage crossing the MAIN ↔ ISOLATED boundary. */
const CHANNEL_NONCE =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `xrc-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** How long after a /status/ page opens before a missing TweetDetail is treated as breakage. */
const TWEET_DETAIL_WATCHDOG_MS = 8000;
/** Scanning every <script> tag is expensive; give up rather than repeat it forever (F6). */
const OWN_USER_ID_MAX_SCANS = 5;
const IDENTITY_DEBOUNCE_MS = 250;
export const GRAPHQL_HEALTH_KEY = 'xrcGraphqlHealth';

let currentPost: PostBrief | null = null;
let suggestions: Suggestion[] = [];
let cardVisible = false;
let isReading = false;
let composeReady = false;
let isGenerating = false;
let cardHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let toastHost: HTMLElement | null = null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let detectedOwnHandle: string | null = null;
let detectedOwnUserId: string | null = null;
let ownUserIdScans = 0;
let lastRefinement: RefinementChip | undefined;
let feedbackTimeout: ReturnType<typeof setTimeout> | null = null;
let isInserting = false;

let identityObserver: MutationObserver | null = null;
let identityInterval: ReturnType<typeof setInterval> | null = null;
let identityDebounce: ReturnType<typeof setTimeout> | null = null;
let positionFrame = 0;
let tweetDetailWatchdog: ReturnType<typeof setTimeout> | null = null;

/** Timing marks. Item 1: nothing in this project had ever been measured. */
let replyClickAt: number | null = null;
/** Stamped at Reply click so SPA navigation can clear `currentPost` without losing the clock. */
let replyClickTweetId: string | null = null;
let postOpenAt: number | null = null;
/**
 * In-flight post-open compose prefetch. Reply click awaits this instead of starting a
 * second Stage 2 — `[user]` "by the time i clicked on reply the comments will already be generated".
 */
let composePrefetch: { tweetId: string; promise: Promise<boolean> } | null = null;

const graphqlHealth = {
  interceptorAlive: false,
  seen: [] as string[],
  structural: 0,
  drops: [] as string[],
};

function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
}

function getModifierLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl+';
}

function getPasteShortcutLabel(): string {
  return isMacPlatform() ? '⌘V' : 'Ctrl+V';
}

function isShortcutModifier(e: KeyboardEvent): boolean {
  return isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

function relayToBackground(type: string, payload: unknown): void {
  chrome.runtime
    .sendMessage({ type, payload })
    .catch((e: unknown) => console.warn(`[XRC] relay ${type} failed`, e));
}

function postToMain(msg: Record<string, unknown>): void {
  window.postMessage({ source: CHANNEL, nonce: CHANNEL_NONCE, ...msg }, '*');
}

function isTrustedChannelEvent(event: MessageEvent): boolean {
  if (event.source !== window) return false;
  const data = event.data as { source?: unknown; nonce?: unknown } | null;
  return data?.source === CHANNEL && data?.nonce === CHANNEL_NONCE;
}

function isCreateTweetPayload(
  payload: unknown,
): payload is { fullText: string; tweetId?: string; inReplyTo?: string; inReplyToHandle?: string } {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return typeof p.fullText === 'string' && p.fullText.length > 0;
}

function isHarvestBatch(
  payload: unknown,
): payload is { harvest: Array<{ text: string; handle: string }> } {
  if (!payload || typeof payload !== 'object') return false;
  const harvest = (payload as { harvest?: unknown }).harvest;
  if (!Array.isArray(harvest) || harvest.length === 0) return false;
  return harvest.every(
    (r) =>
      r &&
      typeof r === 'object' &&
      typeof (r as { text?: unknown }).text === 'string' &&
      typeof (r as { handle?: unknown }).handle === 'string',
  );
}

/** Never `void` a storage promise — that is exactly how F3 stayed invisible for months. */
function persistGraphqlHealth(reason: string, tweetId?: string): void {
  chrome.storage.local
    .set({
      [GRAPHQL_HEALTH_KEY]: {
        at: new Date().toISOString(),
        reason,
        tweetId,
        path: window.location.pathname,
        interceptorAlive: graphqlHealth.interceptorAlive,
        seen: graphqlHealth.seen,
        structuralFallbacks: graphqlHealth.structural,
        drops: graphqlHealth.drops.slice(0, 20),
      },
    })
    .catch((e: unknown) => console.warn('[XRC GraphQL] could not persist health record', e));
}

function publishOwnHandle(handle: string): void {
  if (!handle || handle === detectedOwnHandle) return;
  detectedOwnHandle = handle;
  postToMain({ type: 'set_own_handle', handle });
  harvestDebug('content published own handle', handle);
}

function publishOwnUserId(userId: string): void {
  postToMain({ type: 'set_own_user_id', userId });
  harvestDebug('content published own user id', userId);
}

function detectOwnHandleFromDom(): string | null {
  const profileLink = document.querySelector<HTMLAnchorElement>(
    'a[data-testid="AppTabBar_Profile_Link"]',
  );
  const href = profileLink?.getAttribute('href');
  if (href) {
    const match = href.match(/^\/([^/?#]+)/);
    if (match?.[1] && match[1] !== 'i') return match[1];
  }

  const accountLink = document.querySelector<HTMLAnchorElement>(
    'a[href*="/settings/account"], a[href^="/"][aria-label*="@"]',
  );
  const accountHref = accountLink?.getAttribute('href');
  if (accountHref) {
    const match = accountHref.match(/^\/([^/?#]+)/);
    if (match?.[1] && match[1] !== 'i' && match[1] !== 'settings') return match[1];
  }

  const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  const label = switcher?.getAttribute('aria-label') ?? switcher?.textContent ?? '';
  const atMatch = label.match(/@([A-Za-z0-9_]+)/);
  if (atMatch?.[1]) return atMatch[1];

  const navLinks = document.querySelectorAll<HTMLAnchorElement>('nav a[href^="/"]');
  for (const link of navLinks) {
    const navHref = link.getAttribute('href') ?? '';
    const navMatch = navHref.match(/^\/([A-Za-z0-9_]{1,15})$/);
    if (!navMatch?.[1]) continue;
    const candidate = navMatch[1];
    if (['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose', 'search'].includes(candidate.toLowerCase())) {
      continue;
    }
    const labelText = link.getAttribute('aria-label') ?? link.textContent ?? '';
    if (/profile|account/i.test(labelText)) return candidate;
  }

  return null;
}

function detectOwnUserIdFromDom(): string | null {
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent ?? '';
    const match = text.match(/"rest_id":"(\d+)".*?"screen_name":"([^"]+)"/);
    if (match?.[1] && match[2] && detectedOwnHandle && match[2].toLowerCase() === detectedOwnHandle.toLowerCase()) {
      return match[1];
    }
  }
  return null;
}

/**
 * Both identifiers are one-shot facts about the logged-in session. Once they are known — or
 * once the script sweep has failed enough times to be worth abandoning — there is nothing
 * left to watch, so the observer and the interval both stop. Previously this ran on every
 * DOM mutation of a virtualised timeline *and* every 5 seconds, regexing the full text of
 * every <script> tag each time (F6).
 */
function identityResolved(): boolean {
  if (!detectedOwnHandle) return false;
  return detectedOwnUserId !== null || ownUserIdScans >= OWN_USER_ID_MAX_SCANS;
}

function stopIdentityWatchers(): void {
  if (identityObserver) {
    identityObserver.disconnect();
    identityObserver = null;
  }
  if (identityInterval !== null) {
    clearInterval(identityInterval);
    identityInterval = null;
  }
  if (identityDebounce !== null) {
    clearTimeout(identityDebounce);
    identityDebounce = null;
  }
}

function syncOwnHandle(): void {
  if (identityResolved()) {
    stopIdentityWatchers();
    return;
  }

  if (!detectedOwnHandle) {
    const handle = detectOwnHandleFromDom();
    if (handle) publishOwnHandle(handle);
  }

  if (detectedOwnHandle && !detectedOwnUserId && ownUserIdScans < OWN_USER_ID_MAX_SCANS) {
    ownUserIdScans++;
    const userId = detectOwnUserIdFromDom();
    if (userId) {
      detectedOwnUserId = userId;
      publishOwnUserId(userId);
    }
  }

  if (identityResolved()) stopIdentityWatchers();
}

function scheduleIdentitySync(): void {
  if (identityDebounce !== null) return;
  identityDebounce = setTimeout(() => {
    identityDebounce = null;
    syncOwnHandle();
  }, IDENTITY_DEBOUNCE_MS);
}

function showActionToast(message: string): void {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.id = 'x-reply-copilot-toast';
    toastHost.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999998;pointer-events:none;';
    document.body.appendChild(toastHost);
  }

  toastHost.textContent = message;
  toastHost.style.cssText =
    'position:fixed;bottom:24px;right:24px;z-index:999998;pointer-events:none;' +
    'font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'background:#15202b;color:#1d9bf0;border:1px solid #38444d;border-radius:999px;padding:8px 14px;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.35);opacity:1;transition:opacity .3s;';

  if (feedbackTimeout) clearTimeout(feedbackTimeout);
  feedbackTimeout = setTimeout(() => {
    if (toastHost) toastHost.style.opacity = '0';
  }, 2200);
}

function showHarvestToast(count: number): void {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.id = 'x-reply-copilot-toast';
    toastHost.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999998;pointer-events:none;';
    document.body.appendChild(toastHost);
  }

  toastHost.textContent = count === 1 ? '+1 reply harvested' : `+${count} replies harvested`;
  toastHost.style.cssText =
    'position:fixed;bottom:24px;right:24px;z-index:999998;pointer-events:none;' +
    'font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'background:#15202b;color:#1d9bf0;border:1px solid #38444d;border-radius:999px;padding:8px 14px;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.35);opacity:1;transition:opacity .3s;';

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    if (toastHost) toastHost.style.opacity = '0';
  }, 2200);
}

function setCurrentPost(brief: PostBrief): void {
  const prev = currentPost;
  const merged = mergePostBrief(currentPost, brief);
  const mediaUpgraded =
    postBriefHasVisualMedia(merged) &&
    (!prev || prev.tweetId !== merged.tweetId || prev.media.length < merged.media.length);
  const repliesUpgraded =
    merged.topReplies.length > 0 && (prev?.topReplies.length ?? 0) === 0;

  currentPost = merged;
  isReading = true;
  updateReadingIndicator();

  if (!prev || prev.tweetId !== merged.tweetId) postOpenAt = now();

  mediaDebug('post captured', {
    tweetId: merged.tweetId,
    textLen: merged.text.length,
    media: merged.media.length,
    mediaUpgraded,
  });

  if (!prev || prev.tweetId !== merged.tweetId || mediaUpgraded || repliesUpgraded) {
    // Richer brief invalidates drafts built from thinner Stage 1 context.
    if (prev?.tweetId === merged.tweetId && (mediaUpgraded || repliesUpgraded)) {
      suggestions = [];
      composeReady = false;
      void clearCachedSuggestions(merged.tweetId);
    }
    void prefetchComprehend(merged);
  }
}

function capturePostFromElement(el: Element): boolean {
  const brief = extractPostBriefFromTweetElement(el);
  if (!brief) return false;
  setCurrentPost(brief);
  return true;
}

function ensureCurrentPost(): boolean {
  if (currentPost) return true;
  const fromDom = findReplyTargetFromDom();
  if (fromDom) {
    setCurrentPost(fromDom);
    return true;
  }
  return false;
}

/** P5: makes a disappeared operation visible instead of letting it produce nothing quietly. */
function recordGraphqlHealth(event: GraphqlHealthEvent): void {
  if (event.operation === 'interceptor_alive') {
    graphqlHealth.interceptorAlive = true;
    logEntry('interceptor replied to the replay handshake', event.reason);
    return;
  }

  graphqlHealth.interceptorAlive = true;

  if (event.kind === 'drop') {
    const label = `${event.operation ?? 'unnamed'} (${event.reason ?? 'no reason'})`;
    if (!graphqlHealth.drops.includes(label)) graphqlHealth.drops.push(label);
    return;
  }

  if (event.kind === 'structural') {
    graphqlHealth.structural++;
    console.warn('[XRC GraphQL] operation name unrecognised — read via the structural fallback', event);
    persistGraphqlHealth('structural-fallback');
  }

  if (event.operation && !graphqlHealth.seen.includes(event.operation)) {
    graphqlHealth.seen.push(event.operation);
  }
}

function handleInterceptorMessage(event: MessageEvent): void {
  // F8: exact channel equality + shared nonce. Forged page-console messages are dropped.
  if (!isTrustedChannelEvent(event)) return;

  const data = event.data as {
    type?: string;
    operation?: string;
    payload?: unknown;
  };

  if (data.type === 'graphql_telemetry') {
    recordGraphqlHealth(data.payload as GraphqlHealthEvent);
    return;
  }

  // Ignore the content script's own set_own_handle / request_replay posts, which share
  // the channel.
  if (data.type !== 'graphql') return;

  const { operation, payload } = data;

  if (operation === 'CreateTweet') {
    if (!isCreateTweetPayload(payload)) return;
    const targetHandle =
      (payload.inReplyTo && currentPost?.tweetId === payload.inReplyTo
        ? currentPost.authorHandle
        : undefined) ||
      payload.inReplyToHandle ||
      currentPost?.authorHandle;
    relayToBackground('CREATE_TWEET', {
      ...payload,
      targetHandle,
      ownHandle: detectedOwnHandle ?? undefined,
    });
    return;
  }

  if (isHarvestBatch(payload)) {
    const batch = payload.harvest;
    if (batch[0]?.handle) publishOwnHandle(batch[0].handle);
    harvestDebug('content received harvest batch', batch.length);
    // One message for the whole batch. This used to await one round trip per reply,
    // serially, inside the interception hot path.
    sendExtensionMessage({ type: 'HARVEST_REPLY', replies: batch })
      .then((res) => {
        if (res.ok && res.added) showHarvestToast(res.added);
      })
      .catch((e: unknown) => harvestDebug('HARVEST_REPLY failed', e));
    return;
  }

  const brief = payload as PostBrief;
  if (!brief?.tweetId || typeof brief.tweetId !== 'string') return;
  if (!(typeof brief.text === 'string' || Array.isArray(brief.media))) return;
  if (!brief.text && !(brief.media?.length)) return;

  // A replayed brief is by definition older than the current page. If the URL already names
  // a specific post, anything else is stale and must not become `currentPost`.
  const openTweetId = window.location.pathname.match(/\/status\/(\d+)/)?.[1];
  if (openTweetId && openTweetId !== brief.tweetId) return;

  logTiming('post open — GraphQL brief received', {
    tweetId: brief.tweetId,
    operation,
    topReplies: brief.topReplies?.length ?? 0,
    media: brief.media?.length ?? 0,
  });
  setCurrentPost(brief);
}

/**
 * Post-open prefetch — `[plan todo:prefetch]` + `[user]` drafts-ready-at-Reply.
 * Q1 default: TweetDetail / status focus only (interceptor never fans out HomeTimeline).
 * Stage 1 then Stage 2 for the same tweet; Reply click serves `suggestions:<tweetId>`.
 */
async function prefetchComprehend(brief: PostBrief): Promise<void> {
  const startedAt = now();
  try {
    const res = await sendExtensionMessage({ type: 'COMPREHEND', postBrief: brief });
    logTiming('comprehend resolved', {
      tweetId: brief.tweetId,
      source: brief.source ?? 'dom',
      ok: res.ok,
      topReplies: brief.topReplies?.length ?? 0,
      roundTripMs: since(startedAt),
      postOpenToComprehendMs: postOpenAt != null ? since(postOpenAt) : undefined,
      worker: res.ok ? res.timing : undefined,
    });
    // Compose only after a usable Stage 1 — do not burn a Stage 2 on a failed comprehend.
    if (res.ok && currentPost?.tweetId === brief.tweetId) {
      void prefetchCompose(brief);
    }
  } catch (e) {
    logTiming('comprehend prefetch failed', {
      tweetId: brief.tweetId,
      roundTripMs: since(startedAt),
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Stage 2 on post-open (same tweet). Silent — no card "generating" until Reply.
 * Caches via `handleCompose` → `suggestions:<tweetId>`.
 */
async function prefetchCompose(brief: PostBrief): Promise<void> {
  if (composePrefetch?.tweetId === brief.tweetId) return;

  const promise = (async (): Promise<boolean> => {
    const startedAt = now();
    try {
      const existing = await sendExtensionMessage({
        type: 'GET_SUGGESTIONS',
        tweetId: brief.tweetId,
      });
      if (existing.ok && existing.suggestions?.length) {
        if (currentPost?.tweetId === brief.tweetId) {
          suggestions = existing.suggestions;
          composeReady = true;
        }
        logTiming('compose prefetch cache hit', {
          tweetId: brief.tweetId,
          postOpenToComposeMs: postOpenAt != null ? since(postOpenAt) : undefined,
        });
        return true;
      }

      const res = await sendExtensionMessage({ type: 'COMPOSE', postBrief: brief });
      logTiming('compose prefetch resolved', {
        tweetId: brief.tweetId,
        source: brief.source ?? 'dom',
        ok: res.ok,
        suggestionCount: res.ok ? res.suggestions?.length ?? 0 : 0,
        roundTripMs: since(startedAt),
        postOpenToComposeMs: postOpenAt != null ? since(postOpenAt) : undefined,
        worker: res.ok ? res.timing : undefined,
      });

      if (res.ok && res.suggestions?.length && currentPost?.tweetId === brief.tweetId) {
        suggestions = res.suggestions;
        composeReady = true;
        if (cardVisible) {
          renderSuggestions();
          setRefinementsEnabled(true);
          setLoading(false);
          if (res.governor) updateBudgetDisplay(res.governor.remainingBudget);
          if (res.usageSummary) updateSpendDisplay(res.usageSummary.totalUsd);
          logTiming('card rendered', {
            tweetId: brief.tweetId,
            source: brief.source ?? 'dom',
            refinement: 'none',
            cache: 'prefetch',
            clickToCardMs: replyClickAt != null ? since(replyClickAt) : undefined,
            worker: res.timing,
          });
        }
        return true;
      }
      return false;
    } catch (e) {
      logTiming('compose prefetch failed', {
        tweetId: brief.tweetId,
        roundTripMs: since(startedAt),
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  })();

  composePrefetch = { tweetId: brief.tweetId, promise };
  try {
    await promise;
  } finally {
    if (composePrefetch?.promise === promise) composePrefetch = null;
  }
}

function logCardRendered(cache: 'memory' | 'session' | 'prefetch' | 'compose'): void {
  if (!currentPost) return;
  logTiming('card rendered', {
    tweetId: currentPost.tweetId,
    source: currentPost.source ?? 'dom',
    refinement: lastRefinement ?? 'none',
    cache,
    clickToCardMs: replyClickAt != null ? since(replyClickAt) : undefined,
  });
}

async function loadCachedSuggestions(): Promise<boolean> {
  if (!currentPost) return false;
  try {
    const res = await sendExtensionMessage({
      type: 'GET_SUGGESTIONS',
      tweetId: currentPost.tweetId,
    });
    if (res.ok && res.suggestions?.length) {
      suggestions = res.suggestions;
      composeReady = true;
      renderSuggestions();
      setRefinementsEnabled(true);
      return true;
    }
  } catch {
    /* fall through to compose */
  }
  return false;
}

async function composeSuggestions(refinement?: RefinementChip): Promise<void> {
  createCard();

  if (!ensureCurrentPost()) {
    showError(
      'No post captured yet. Click Reply on a tweet, then try again.',
      false,
    );
    setRefinementsEnabled(false);
    return;
  }

  if (isGenerating) return;

  clearError();
  clearNudge();
  setLoading(true);
  isGenerating = true;
  lastRefinement = refinement;
  const composeStartedAt = now();

  try {
    const res = await sendExtensionMessage({
      type: 'COMPOSE',
      postBrief: currentPost!,
      refinement,
    });

    if (res.ok && res.suggestions?.length) {
      suggestions = res.suggestions;
      composeReady = true;
      renderSuggestions();
      setRefinementsEnabled(true);
      logTiming('card rendered', {
        tweetId: currentPost!.tweetId,
        source: currentPost!.source ?? 'dom',
        refinement: refinement ?? 'none',
        cache: res.timing?.composeCached ? 'session' : 'compose',
        composeRoundTripMs: since(composeStartedAt),
        clickToCardMs: replyClickAt != null ? since(replyClickAt) : undefined,
        worker: res.timing,
      });
      if (res.governor) updateBudgetDisplay(res.governor.remainingBudget);
      if (res.usageSummary) updateSpendDisplay(res.usageSummary.totalUsd);
      const nudges: string[] = [];
      if (res.governor?.nudge) nudges.push(res.governor.nudge);
      // F10: degraded Stage 1 must be visible, not silently reused.
      if (res.comprehend?.degraded) {
        nudges.push('Post analysis was thin — drafting from limited context.');
      }
      if (nudges.length) showNudge(nudges.join(' '));
    } else {
      composeReady = false;
      suggestions = [];
      renderSuggestions();
      setRefinementsEnabled(false);
      const reason = res.ok
        ? 'The model returned no usable replies. Open the service worker console on chrome://extensions for details.'
        : res.error;
      showError(reason || 'Failed to generate suggestions', true);
      void refreshGovernorStatus();
    }
  } catch (e) {
    composeReady = false;
    suggestions = [];
    renderSuggestions();
    setRefinementsEnabled(false);
    const msg = e instanceof Error ? e.message : 'Could not reach extension background';
    showError(msg, true);
  } finally {
    setLoading(false);
    isGenerating = false;
  }
}

function createCard(): void {
  if (cardHost) return;

  cardHost = document.createElement('div');
  cardHost.id = 'x-reply-copilot-root';
  cardHost.style.cssText = 'position:fixed;z-index:999999;pointer-events:none;';
  document.body.appendChild(cardHost);

  shadowRoot = cardHost.attachShadow({ mode: 'closed' });

  const wrapper = document.createElement('div');
  wrapper.className = 'xrc-card xrc-hidden';
  wrapper.innerHTML = `
    <div class="xrc-header">
      <span class="xrc-reading" aria-live="polite">Reading this post</span>
      <span class="xrc-budget" aria-live="polite" title="Daily reply budget remaining"></span>
      <span class="xrc-spend" aria-live="polite" title="Estimated lifetime Gemini spend"></span>
      <button class="xrc-close" aria-label="Dismiss">×</button>
    </div>
    <div class="xrc-disclosure">This extension reads posts you view on X to suggest replies. Data goes directly to Gemini with your API key.</div>
    <div class="xrc-loading xrc-hidden" aria-live="polite">Generating…</div>
    <div class="xrc-error xrc-hidden" role="alert">
      <span class="xrc-error-text"></span>
      <button type="button" class="xrc-retry xrc-hidden">Retry</button>
    </div>
    <div class="xrc-nudge xrc-hidden"></div>
    <div class="xrc-suggestions"></div>
    <div class="xrc-refinements">
      <button data-refine="shorter" disabled>Shorter</button>
      <button data-refine="sharper" disabled>Sharper</button>
      <button data-refine="funnier" disabled>Funnier</button>
      <button data-refine="less_agreeable" disabled>Less agreeable</button>
      <button data-refine="add_question" disabled>Add question</button>
    </div>
    <div class="xrc-hint"></div>
  `;

  updateHintText();

  const style = document.createElement('style');
  style.textContent = getInlineStyles();
  shadowRoot.appendChild(style);
  shadowRoot.appendChild(wrapper);

  wrapper.querySelector('.xrc-close')?.addEventListener('click', hideCard);
  wrapper.querySelector('.xrc-retry')?.addEventListener('click', () => {
    void composeSuggestions(lastRefinement);
  });
  wrapper.querySelectorAll('[data-refine]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if ((btn as HTMLButtonElement).disabled || !composeReady) return;
      const chip = (btn as HTMLElement).dataset.refine as RefinementChip;
      void composeSuggestions(chip);
    });
  });

  cardHost.style.pointerEvents = 'auto';
}

function getInlineStyles(): string {
  return `
    .xrc-card { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #15202b; color: #e7e9ea; border: 1px solid #38444d; border-radius: 16px;
      padding: 12px 14px; width: 360px; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
    .xrc-hidden { display: none !important; }
    .xrc-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
    .xrc-reading { font-size: 12px; color: #1d9bf0; font-weight: 600; }
    .xrc-reading.xrc-idle { color: #71767b; }
    .xrc-budget { font-size: 11px; color: #71767b; margin-left: auto; white-space: nowrap; }
    .xrc-budget.xrc-budget-low { color: #ffad1f; }
    .xrc-budget.xrc-budget-blocked { color: #f4212e; }
    .xrc-spend { font-size: 11px; color: #71767b; white-space: nowrap; }
    .xrc-close { background: none; border: none; color: #71767b; font-size: 20px; cursor: pointer; }
    .xrc-disclosure { font-size: 11px; color: #71767b; margin-bottom: 10px; line-height: 1.4; }
    .xrc-suggestion { padding: 10px 12px; margin-bottom: 8px; background: #192734; border-radius: 12px;
      cursor: pointer; border: 1px solid transparent; transition: border-color .15s; }
    .xrc-suggestion:hover { border-color: #1d9bf0; }
    .xrc-suggestion.xrc-inserted { border-color: #00ba7c; background: #1a2e28; }
    .xrc-intent { font-size: 10px; text-transform: uppercase; color: #1d9bf0; font-weight: 700; margin-bottom: 4px; }
    .xrc-text { font-size: 14px; line-height: 1.4; }
    .xrc-refinements { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .xrc-refinements button { font-size: 11px; padding: 4px 10px; border-radius: 999px;
      border: 1px solid #38444d; background: transparent; color: #e7e9ea; cursor: pointer; }
    .xrc-refinements button:hover:not(:disabled) { background: #22303c; }
    .xrc-refinements button:disabled { opacity: 0.4; cursor: not-allowed; }
    .xrc-hint { font-size: 11px; color: #71767b; margin-top: 8px; }
    .xrc-loading, .xrc-error, .xrc-nudge { font-size: 13px; margin-bottom: 8px; }
    .xrc-error { color: #f4212e; line-height: 1.4; }
    .xrc-error-text { display: block; margin-bottom: 6px; }
    .xrc-retry { font-size: 11px; padding: 4px 12px; border-radius: 999px;
      border: 1px solid #f4212e; background: transparent; color: #f4212e; cursor: pointer; }
    .xrc-retry:hover { background: rgba(244,33,46,.12); }
    .xrc-nudge { color: #ffad1f; }
  `;
}

/** Scroll fires far faster than the screen repaints; one reposition per frame is enough. */
function schedulePositionCard(): void {
  if (positionFrame) return;
  positionFrame = requestAnimationFrame(() => {
    positionFrame = 0;
    positionCard();
  });
}

function positionCard(): void {
  if (!cardHost || !shadowRoot) return;
  const composer = findComposer();
  const card = shadowRoot.querySelector('.xrc-card') as HTMLElement | null;
  if (!composer || !card) return;

  const rect = composer.getBoundingClientRect();
  cardHost.style.top = `${rect.bottom + 8}px`;
  cardHost.style.left = `${Math.max(8, rect.left)}px`;
}

async function showCard(): Promise<void> {
  createCard();
  const card = shadowRoot?.querySelector('.xrc-card');
  card?.classList.remove('xrc-hidden');
  cardVisible = true;
  positionCard();

  ensureCurrentPost();
  void refreshGovernorStatus();

  if (composeReady && suggestions.length > 0) {
    renderSuggestions();
    setRefinementsEnabled(true);
    setLoading(false);
    logCardRendered('memory');
    return;
  }

  // Prefetch still running for this tweet — show generating and await; do not double-compose.
  const inflightPrefetch = composePrefetch;
  if (
    currentPost &&
    inflightPrefetch?.tweetId === currentPost.tweetId &&
    !isGenerating
  ) {
    setLoading(true);
    const ok = await inflightPrefetch.promise;
    if (ok && composeReady && suggestions.length > 0) {
      renderSuggestions();
      setRefinementsEnabled(true);
      setLoading(false);
      logCardRendered('prefetch');
      return;
    }
  }

  const cached = await loadCachedSuggestions();
  if (cached) {
    setLoading(false);
    logCardRendered('session');
    return;
  }
  if (!isGenerating) {
    void composeSuggestions();
  }
}

function hideCard(): void {
  shadowRoot?.querySelector('.xrc-card')?.classList.add('xrc-hidden');
  cardVisible = false;
}

function setLoading(loading: boolean): void {
  shadowRoot?.querySelector('.xrc-loading')?.classList.toggle('xrc-hidden', !loading);
}

function clearError(): void {
  const el = shadowRoot?.querySelector('.xrc-error') as HTMLElement | null;
  if (el) {
    el.classList.add('xrc-hidden');
    const text = el.querySelector('.xrc-error-text');
    if (text) text.textContent = '';
  }
  shadowRoot?.querySelector('.xrc-retry')?.classList.add('xrc-hidden');
}

function showError(msg: string, showRetry: boolean): void {
  const el = shadowRoot?.querySelector('.xrc-error') as HTMLElement | null;
  const textEl = shadowRoot?.querySelector('.xrc-error-text') as HTMLElement | null;
  const retryBtn = shadowRoot?.querySelector('.xrc-retry') as HTMLElement | null;
  if (el && textEl) {
    textEl.textContent = msg;
    el.classList.remove('xrc-hidden');
  }
  if (retryBtn) {
    retryBtn.classList.toggle('xrc-hidden', !showRetry);
  }
}

function clearNudge(): void {
  shadowRoot?.querySelector('.xrc-nudge')?.classList.add('xrc-hidden');
}

function showNudge(msg: string): void {
  const el = shadowRoot?.querySelector('.xrc-nudge') as HTMLElement | null;
  if (el) {
    el.textContent = msg;
    el.classList.remove('xrc-hidden');
  }
}

/** Hard visible budget — `[plan todo:governor]` / F2. */
function updateBudgetDisplay(remaining: number): void {
  const el = shadowRoot?.querySelector('.xrc-budget') as HTMLElement | null;
  if (!el) return;
  el.textContent = remaining <= 0 ? 'Budget: 0 left' : `${remaining} left today`;
  el.classList.toggle('xrc-budget-low', remaining > 0 && remaining <= 5);
  el.classList.toggle('xrc-budget-blocked', remaining <= 0);
}

/** Lifetime estimated Gemini spend — numbers only, never the API key (I4). */
function updateSpendDisplay(totalUsd: number): void {
  const el = shadowRoot?.querySelector('.xrc-spend') as HTMLElement | null;
  if (!el) return;
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
    el.textContent = '';
    return;
  }
  const text =
    totalUsd < 0.001
      ? `~$${totalUsd.toFixed(5)}`
      : totalUsd < 0.01
        ? `~$${totalUsd.toFixed(4)}`
        : `~$${totalUsd.toFixed(3)}`;
  el.textContent = `${text} spent`;
}

async function refreshGovernorStatus(): Promise<void> {
  const handle = currentPost?.authorHandle;
  if (!handle) return;
  try {
    const res = await sendExtensionMessage({ type: 'GET_GOVERNOR_STATUS', targetHandle: handle });
    if (res.ok && res.governor) {
      updateBudgetDisplay(res.governor.remainingBudget);
      if (res.governor.nudge) showNudge(res.governor.nudge);
    }
  } catch {
    /* budget display is best-effort */
  }
}

function setRefinementsEnabled(enabled: boolean): void {
  shadowRoot?.querySelectorAll('[data-refine]').forEach((btn) => {
    (btn as HTMLButtonElement).disabled = !enabled;
  });
}

function updateReadingIndicator(): void {
  const el = shadowRoot?.querySelector('.xrc-reading');
  if (el) {
    el.classList.toggle('xrc-idle', !isReading);
    el.textContent = isReading ? 'Reading this post' : 'Idle';
  }
}

function updateHintText(): void {
  const hint = shadowRoot?.querySelector('.xrc-hint');
  if (hint) {
    hint.textContent = `${getModifierLabel()}1/2/3 to insert · Click to insert`;
  }
}

function renderSuggestions(): void {
  const container = shadowRoot?.querySelector('.xrc-suggestions');
  if (!container) return;
  container.innerHTML = '';
  updateHintText();

  const mod = getModifierLabel();
  suggestions.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'xrc-suggestion';
    div.dataset.index = String(i);
    div.innerHTML = `<div class="xrc-intent">${s.intent} · ${mod}${i + 1}</div><div class="xrc-text">${escapeHtml(s.text)}</div>`;
    div.addEventListener('click', () => selectSuggestion(i, true));
    container.appendChild(div);
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function flashSuggestionItem(index: number): void {
  const item = shadowRoot?.querySelector(`.xrc-suggestion[data-index="${index}"]`);
  if (!item) return;
  item.classList.add('xrc-inserted');
  setTimeout(() => item.classList.remove('xrc-inserted'), 1200);
}

async function selectSuggestion(index: number, insert: boolean): Promise<void> {
  const s = suggestions[index];
  if (!s || !currentPost) return;
  if (insert && isInserting) return;

  // F3: this write used to be `void`-ed, so the access-level rejection was invisible and
  // `served:<tweetId>` silently never existed. The worker now grants content scripts access
  // to session storage; if that ever regresses, this says so.
  setLastServedSuggestion(currentPost.tweetId, s.text, index).catch((e: unknown) =>
    console.warn('[XRC] could not record the served suggestion', e),
  );

  if (insert) {
    isInserting = true;
    try {
      focusComposer();
      const result = await insertIntoComposer(s.text);

      if (result.success) {
        flashSuggestionItem(index);
        showActionToast('Inserted');
        // Clipboard is a manual-paste fallback only — do not re-insert.
        void copyToClipboard(s.text);
        return;
      }

      const copied = await copyToClipboard(s.text);
      flashSuggestionItem(index);
      showActionToast(
        copied
          ? `Copied — paste manually (${getPasteShortcutLabel()})`
          : 'Could not insert — try clicking the composer first',
      );
    } finally {
      isInserting = false;
    }
    return;
  }

  const copied = await copyToClipboard(s.text);
  showActionToast(copied ? 'Copied' : 'Copy failed');
}

function setupComposerWatchers(ctx: InstanceType<typeof ContentScriptContext>): void {
  const checkFocus = () => {
    if (isComposerFocused()) {
      if (!cardVisible) void showCard();
      else positionCard();
    }
  };

  ctx.addEventListener(document, 'focusin', checkFocus, { capture: true });
  ctx.addEventListener(window, 'scroll', () => {
    if (cardVisible) schedulePositionCard();
  }, { capture: true });

  ctx.addEventListener(document, 'keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Escape' && cardVisible) {
      ke.preventDefault();
      hideCard();
      return;
    }

    if (!cardVisible || !isShortcutModifier(ke)) return;

    const key = ke.key;
    if (key === '1' || key === '2' || key === '3') {
      ke.preventDefault();
      ke.stopPropagation();
      void selectSuggestion(Number(key) - 1, true);
    }
  }, { capture: true });
}

function setupReplyCapture(ctx: InstanceType<typeof ContentScriptContext>): void {
  ctx.addEventListener(document, 'click', (e: Event) => {
    const target = e.target as HTMLElement;
    const replyBtn = target.closest('[data-testid="reply"]');
    if (!replyBtn) return;

    replyClickAt = now();

    const tweet = replyBtn.closest('article[data-testid="tweet"]');
    const captured = tweet ? capturePostFromElement(tweet) : false;
    replyClickTweetId = currentPost?.tweetId ?? null;

    // Was `if (cardVisible || isComposerFocused())`. Neither is true at click time — the
    // composer has not opened yet — so compose was in practice driven by the later
    // `focusin`, which is pure added delay on the one path where latency is visible.
    // Still guarded on having a post: without one, `composeSuggestions` would only render
    // "No post captured yet", and the composer that `findReplyTargetFromDom` needs does
    // not exist this early.
    if (captured || currentPost) void showCard();
  }, { capture: true });
}

/**
 * P5. The extension depends on TweetDetail above all else. If the user has a post open and
 * it never arrives, that is breakage, and it says so rather than silently serving the
 * poorer DOM path — which is what made F1 survivable for as long as it did.
 */
function armTweetDetailWatchdog(): void {
  if (tweetDetailWatchdog !== null) {
    clearTimeout(tweetDetailWatchdog);
    tweetDetailWatchdog = null;
  }

  const match = window.location.pathname.match(/\/status\/(\d+)/);
  if (!match?.[1]) return;
  const tweetId = match[1];

  tweetDetailWatchdog = setTimeout(() => {
    tweetDetailWatchdog = null;
    if (currentPost?.tweetId === tweetId && currentPost.source === 'graphql') return;

    console.warn(
      '[XRC GraphQL] no TweetDetail payload for the open post — degraded to the DOM path.',
      {
        tweetId,
        interceptorAlive: graphqlHealth.interceptorAlive,
        operationsSeen: graphqlHealth.seen,
        drops: graphqlHealth.drops,
      },
    );
    persistGraphqlHealth(
      graphqlHealth.interceptorAlive ? 'tweet-detail-missing' : 'interceptor-silent',
      tweetId,
    );
  }, TWEET_DETAIL_WATCHDOG_MS);
}

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    logEntry('content script — ISOLATED world, document_idle', window.location.pathname);

    window.addEventListener('message', handleInterceptorMessage);

    // F8: establish the shared nonce before replaying buffered GraphQL (and before identity).
    postToMain({ type: 'init_channel', nonce: CHANNEL_NONCE });
    // This script starts at document_idle; the interceptor starts at document_start. On a
    // direct load of a /status/ URL, TweetDetail can land in that gap. Ask for a replay.
    postToMain({ type: 'request_replay' });

    syncOwnHandle();
    setupComposerWatchers(ctx);
    setupReplyCapture(ctx);
    armTweetDetailWatchdog();

    if (!identityResolved()) {
      identityInterval = setInterval(syncOwnHandle, 5000);
      // Scoped to the chrome around the timeline rather than document.body: the handle and
      // user id only ever appear in the nav, and the timeline is the part that mutates
      // continuously while scrolling.
      identityObserver = new MutationObserver(scheduleIdentitySync);
      identityObserver.observe(
        document.querySelector('header[role="banner"]') ??
          document.querySelector('nav') ??
          document.body,
        { childList: true, subtree: true },
      );
    }

    ctx.onInvalidated(stopIdentityWatchers);

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      // Reply-from-timeline often SPA-navigates into /status/<sameId>. Key the click clock
      // off `replyClickTweetId` (not `currentPost`) so a second locationchange after we
      // null the post cannot wipe `clickToCardMs` (item 1 instrumentation).
      const nextTweetId = window.location.pathname.match(/\/status\/(\d+)/)?.[1];
      const keepSamePost =
        currentPost != null &&
        nextTweetId != null &&
        nextTweetId === currentPost.tweetId;
      const keepClickClock =
        replyClickAt != null &&
        replyClickTweetId != null &&
        nextTweetId != null &&
        nextTweetId === replyClickTweetId;

      if (!keepSamePost) {
        currentPost = null;
        isReading = false;
        suggestions = [];
        composeReady = false;
        lastRefinement = undefined;
        postOpenAt = null;
        composePrefetch = null;
        hideCard();
      }
      if (!keepClickClock) {
        replyClickAt = null;
        replyClickTweetId = null;
      }
      syncOwnHandle();
      armTweetDetailWatchdog();
      // Deliberately no replay here: the interceptor is already live for this navigation,
      // and replaying its buffer would hand us the previous post's brief.
    });
  },
});
