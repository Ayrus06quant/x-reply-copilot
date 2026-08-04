import './card.css';
import type { PostBrief, RefinementChip, Suggestion } from '../lib/types';
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
import { setLastServedSuggestion } from '../lib/storage';
import { harvestDebug, mediaDebug } from '../lib/debug';

const CHANNEL = 'x-reply-copilot';

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
let lastRefinement: RefinementChip | undefined;
let feedbackTimeout: ReturnType<typeof setTimeout> | null = null;
let isInserting = false;

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
  void chrome.runtime.sendMessage({ type, payload });
}

function publishOwnHandle(handle: string): void {
  if (!handle || handle === detectedOwnHandle) return;
  detectedOwnHandle = handle;
  window.postMessage({ source: CHANNEL, type: 'set_own_handle', handle }, '*');
  harvestDebug('content published own handle', handle);
}

function publishOwnUserId(userId: string): void {
  window.postMessage({ source: CHANNEL, type: 'set_own_user_id', userId }, '*');
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

function syncOwnHandle(): void {
  const handle = detectOwnHandleFromDom();
  if (handle) publishOwnHandle(handle);
  const userId = detectOwnUserIdFromDom();
  if (userId) publishOwnUserId(userId);
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

  currentPost = merged;
  isReading = true;
  updateReadingIndicator();

  mediaDebug('post captured', {
    tweetId: merged.tweetId,
    textLen: merged.text.length,
    media: merged.media.length,
    mediaUpgraded,
  });

  if (!prev || prev.tweetId !== merged.tweetId || mediaUpgraded) {
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

function handleInterceptorMessage(event: MessageEvent): void {
  if (event.source !== window || !event.data?.source?.startsWith?.(CHANNEL)) return;

  const { operation, payload } = event.data as {
    operation: string;
    payload: unknown;
  };

  if (operation === 'CreateTweet') {
    const created = payload as { fullText: string; tweetId?: string; inReplyTo?: string };
    relayToBackground('CREATE_TWEET', created);
    return;
  }

  const harvestPayload = payload as { harvest?: Array<{ text: string; handle: string }> };
  if (harvestPayload?.harvest?.length) {
    const batch = harvestPayload.harvest;
    if (batch[0]?.handle) publishOwnHandle(batch[0].handle);
    harvestDebug('content received harvest batch', batch.length);
    void (async () => {
      let stored = 0;
      for (const r of batch) {
        try {
          const res = await sendExtensionMessage({
            type: 'HARVEST_REPLY',
            text: r.text,
            handle: r.handle,
          });
          if (res.ok && res.added) stored++;
        } catch (e) {
          harvestDebug('HARVEST_REPLY failed', e);
        }
      }
      if (stored > 0) showHarvestToast(stored);
    })();
    return;
  }

  const brief = payload as PostBrief;
  if (brief?.tweetId && (brief?.text || brief?.media?.length)) {
    setCurrentPost(brief);
  }
}

async function prefetchComprehend(brief: PostBrief): Promise<void> {
  try {
    await sendExtensionMessage({ type: 'COMPREHEND', postBrief: brief });
  } catch {
    /* prefetch is best-effort */
  }
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
      if (res.governor?.nudge) showNudge(res.governor.nudge);
    } else {
      composeReady = false;
      suggestions = [];
      renderSuggestions();
      setRefinementsEnabled(false);
      const reason = res.ok
        ? 'The model returned no usable replies. Open the service worker console on chrome://extensions for details.'
        : res.error;
      showError(reason || 'Failed to generate suggestions', true);
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
    .xrc-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .xrc-reading { font-size: 12px; color: #1d9bf0; font-weight: 600; }
    .xrc-reading.xrc-idle { color: #71767b; }
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

  if (composeReady && suggestions.length > 0) return;

  const cached = await loadCachedSuggestions();
  if (!cached && !isGenerating) {
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

  void setLastServedSuggestion(currentPost.tweetId, s.text, index);

  if (insert) {
    isInserting = true;
    try {
      focusComposer();
      const result = insertIntoComposer(s.text);

      if (result.success) {
        flashSuggestionItem(index);
        showActionToast('Inserted');
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

  ctx.addEventListener(document, 'focusin', checkFocus, true);
  ctx.addEventListener(window, 'scroll', () => {
    if (cardVisible) positionCard();
  }, true);

  ctx.addEventListener(document, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && cardVisible) {
      e.preventDefault();
      hideCard();
      return;
    }

    if (!cardVisible || !isShortcutModifier(e)) return;

    const key = e.key;
    if (key === '1' || key === '2' || key === '3') {
      e.preventDefault();
      e.stopPropagation();
      void selectSuggestion(Number(key) - 1, true);
    }
  }, true);
}

function setupReplyCapture(ctx: InstanceType<typeof ContentScriptContext>): void {
  ctx.addEventListener(document, 'click', (e: Event) => {
    const target = e.target as HTMLElement;
    const replyBtn = target.closest('[data-testid="reply"]');
    if (!replyBtn) return;

    const tweet = replyBtn.closest('article[data-testid="tweet"]');
    if (tweet) capturePostFromElement(tweet);

    if (cardVisible || isComposerFocused()) {
      void composeSuggestions();
    }
  }, true);
}

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    syncOwnHandle();
    ctx.setInterval(syncOwnHandle, 5000);

    window.addEventListener('message', handleInterceptorMessage);
    setupComposerWatchers(ctx);
    setupReplyCapture(ctx);

    const observer = new MutationObserver(() => {
      syncOwnHandle();
      if (isComposerFocused() && !cardVisible) void showCard();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      currentPost = null;
      isReading = false;
      suggestions = [];
      composeReady = false;
      lastRefinement = undefined;
      syncOwnHandle();
      hideCard();
    });
  },
});
