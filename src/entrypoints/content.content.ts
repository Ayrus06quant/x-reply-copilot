import type { ExtensionMessage, ExtensionResponse } from '../types/messages';
import type { PostBrief, RefinementModifier, Suggestion } from '../types/post';
import { INTERCEPTOR_SOURCE } from '../lib/interceptor';

let currentPost: PostBrief | null = null;
let suggestions: Suggestion[] = [];
let selectedSuggestionId: string | undefined;
let shadowHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let readingIndicator: HTMLElement | null = null;
let cardVisible = false;

function sendToBackground(msg: ExtensionMessage): Promise<ExtensionResponse | undefined> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}

function createShadowUI(): ShadowRoot {
  if (shadowHost && shadowRoot) return shadowRoot;

  shadowHost = document.createElement('div');
  shadowHost.id = 'x-reply-copilot-host';
  shadowHost.style.cssText = 'all: initial; position: fixed; z-index: 999999; pointer-events: none;';
  document.body.appendChild(shadowHost);

  shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .reading-indicator {
      position: fixed; bottom: 16px; right: 16px;
      background: rgba(29,155,240,0.15); border: 1px solid rgba(29,155,240,0.4);
      color: #1d9bf0; padding: 6px 12px; border-radius: 999px;
      font-size: 12px; pointer-events: none; display: none;
    }
    .reading-indicator.active { display: block; }
    .card {
      position: fixed; bottom: 60px; right: 16px; width: 360px;
      background: #000; border: 1px solid #2f3336; border-radius: 16px;
      padding: 12px; pointer-events: auto; display: none;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .card.visible { display: block; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .card-title { color: #e7e9ea; font-size: 14px; font-weight: 600; }
    .card-dismiss { background: none; border: none; color: #71767b; cursor: pointer; font-size: 18px; }
    .suggestion {
      background: #16181c; border: 1px solid #2f3336; border-radius: 12px;
      padding: 10px 12px; margin-bottom: 8px; cursor: pointer; transition: border-color 0.15s;
    }
    .suggestion:hover { border-color: #1d9bf0; }
    .intent-tag {
      display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase;
      padding: 2px 6px; border-radius: 4px; margin-bottom: 4px;
    }
    .intent-Add { background: rgba(0,186,124,0.2); color: #00ba7c; }
    .intent-Ask { background: rgba(29,155,240,0.2); color: #1d9bf0; }
    .intent-Push\\ back { background: rgba(249,24,128,0.2); color: #f91880; }
    .suggestion-text { color: #e7e9ea; font-size: 14px; line-height: 1.4; }
    .hint { color: #71767b; font-size: 11px; margin-top: 4px; }
    .refine-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .refine-btn {
      background: #16181c; border: 1px solid #2f3336; color: #e7e9ea;
      padding: 4px 8px; border-radius: 999px; font-size: 11px; cursor: pointer;
    }
    .refine-btn:hover { background: #2f3336; }
    .governor-warn { color: #ffad1f; font-size: 11px; margin-bottom: 8px; }
    .loading { color: #71767b; font-size: 13px; padding: 12px; text-align: center; }
  `;
  shadowRoot.appendChild(style);

  readingIndicator = document.createElement('div');
  readingIndicator.className = 'reading-indicator';
  readingIndicator.textContent = '📖 Reading this post';
  shadowRoot.appendChild(readingIndicator);

  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'xrc-card';
  shadowRoot.appendChild(card);

  return shadowRoot;
}

function getCardEl(): HTMLElement | null {
  return shadowRoot?.getElementById('xrc-card') ?? null;
}

function setReadingActive(active: boolean): void {
  createShadowUI();
  readingIndicator?.classList.toggle('active', active);
}

function renderCard(loading = false, governorWarn = ''): void {
  createShadowUI();
  const card = getCardEl();
  if (!card) return;

  if (!cardVisible) {
    card.classList.remove('visible');
    return;
  }

  card.classList.add('visible');

  if (loading) {
    card.innerHTML = `<div class="loading">Generating suggestions…</div>`;
    return;
  }

  const govHtml = governorWarn ? `<div class="governor-warn">${governorWarn}</div>` : '';

  const suggestionsHtml = suggestions
    .map(
      (s, i) => `
    <div class="suggestion" data-index="${i}" data-id="${s.id}">
      <span class="intent-tag intent-${s.intent}">${s.intent}</span>
      <div class="suggestion-text">${escapeHtml(s.text)}</div>
      <div class="hint">Click or ⌘${i + 1} to insert · copies to clipboard</div>
    </div>`,
    )
    .join('');

  const modifiers: RefinementModifier[] = ['shorter', 'sharper', 'funnier', 'less_agreeable', 'add_question'];
  const refineHtml = modifiers
    .map(
      (m) =>
        `<button class="refine-btn" data-modifier="${m}">${m.replace(/_/g, ' ')}</button>`,
    )
    .join('');

  card.innerHTML = `
    <div class="card-header">
      <span class="card-title">Reply suggestions</span>
      <button class="card-dismiss" id="xrc-dismiss">×</button>
    </div>
    ${govHtml}
    ${suggestionsHtml || '<div class="loading">No suggestions yet</div>'}
    <div class="refine-row">${refineHtml}</div>
  `;

  card.querySelector('#xrc-dismiss')?.addEventListener('click', hideCard);
  card.querySelectorAll('.suggestion').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.getAttribute('data-index') ?? '0', 10);
      const id = el.getAttribute('data-id') ?? undefined;
      insertSuggestion(idx, id);
    });
  });
  card.querySelectorAll('.refine-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const mod = el.getAttribute('data-modifier') as RefinementModifier;
      refineSuggestions(mod);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findComposer(): HTMLElement | null {
  return (
    document.querySelector('[data-testid="tweetTextarea_0"]') ??
    document.querySelector('[contenteditable="true"][role="textbox"]')
  );
}

async function insertViaSyntheticPaste(text: string, el: HTMLElement): boolean {
  el.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  });
  const prevented = !el.dispatchEvent(pasteEvent);
  if (prevented) return true;

  const before = el.textContent ?? '';
  if (before.includes(text.slice(0, 20))) return true;
  return false;
}

function insertViaExecCommand(text: string, el: HTMLElement): boolean {
  el.focus();
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    sel.deleteFromDocument();
  }
  return document.execCommand('insertText', false, text);
}

function verifyPostButton(): boolean {
  const btn = document.querySelector('[data-testid="tweetButton"]') ??
    document.querySelector('[data-testid="tweetButtonInline"]');
  if (!btn) return true;
  return btn.getAttribute('aria-disabled') !== 'true';
}

async function insertSuggestion(index: number, suggestionId?: string): Promise<void> {
  const s = suggestions[index];
  if (!s) return;

  selectedSuggestionId = suggestionId ?? s.id;

  try {
    await navigator.clipboard.writeText(s.text);
  } catch {
    /* clipboardWrite permission may still work via extension */
    chrome.runtime.sendMessage({ type: 'CLIPBOARD_WRITE', text: s.text }).catch(() => {});
  }

  const composer = findComposer();
  if (!composer) return;

  const pasted = await insertViaSyntheticPaste(s.text, composer);
  if (!pasted) {
    insertViaExecCommand(s.text, composer);
  }

  setTimeout(() => {
    if (!verifyPostButton()) {
      insertViaExecCommand(s.text, composer);
    }
  }, 100);
}

async function loadSuggestions(): Promise<void> {
  if (!currentPost) return;
  renderCard(true);

  const gov = await sendToBackground({ type: 'GET_GOVERNOR_STATUS' });
  const warn =
    gov?.type === 'GOVERNOR_STATUS' && gov.dailyUsed >= gov.dailyBudget * 0.8
      ? `Daily budget: ${gov.dailyUsed}/${gov.dailyBudget} replies`
      : '';

  const resp = await sendToBackground({ type: 'GET_SUGGESTIONS', postId: currentPost.id });
  if (resp?.type === 'SUGGESTIONS') {
    suggestions = resp.suggestions;
    renderCard(false, warn);
  } else if (resp?.type === 'SUGGESTIONS_ERROR') {
    renderCard(false, resp.error);
  }
}

async function refineSuggestions(modifier: RefinementModifier): Promise<void> {
  if (!currentPost) return;
  renderCard(true);
  const resp = await sendToBackground({ type: 'REFINE', postId: currentPost.id, modifier });
  if (resp?.type === 'SUGGESTIONS') {
    suggestions = resp.suggestions;
    renderCard(false);
  }
}

function showCard(): void {
  cardVisible = true;
  loadSuggestions();
}

function hideCard(): void {
  cardVisible = false;
  renderCard();
  sendToBackground({ type: 'COMPOSER_CLOSED' });
}

function detectComposerOpen(): void {
  const composer = findComposer();
  if (composer && currentPost && !cardVisible) {
    showCard();
    sendToBackground({ type: 'REPLY_CLICKED', postId: currentPost.id });
  }
}

function handleInterceptorMessage(event: MessageEvent): void {
  if (event.source !== window || !event.data?.source || event.data.source !== INTERCEPTOR_SOURCE) {
    return;
  }

  const data = event.data;

  if (data.postBrief) {
    currentPost = data.postBrief as PostBrief;
    setReadingActive(true);
    sendToBackground({ type: 'POST_OPENED', post: currentPost });
  }

  if (data.createTweet) {
    const { text, id } = data.createTweet as { text: string; id: string };
    sendToBackground({
      type: 'CREATE_TWEET',
      text,
      inReplyTo: currentPost?.id,
      suggestionId: selectedSuggestionId,
    });
    selectedSuggestionId = undefined;
    hideCard();
    setReadingActive(false);
  }

  if (data.corpusHint && data.payload) {
    chrome.storage.local.get('ownUserId').then(({ ownUserId }) => {
      if (!ownUserId) return;
      sendToBackground({
        type: 'CORPUS_HARVEST',
        payload: data.payload,
        ownUserId,
      } as unknown as ExtensionMessage);
    });
  }
}

function setupComposerObserver(): void {
  const observer = new MutationObserver(() => {
    detectComposerOpen();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  detectComposerOpen();
}

function setupKeyboardShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    if (!cardVisible) return;
    if (e.key === 'Escape') {
      hideCard();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 3) {
        e.preventDefault();
        insertSuggestion(num - 1);
      }
    }
  });
}

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  runAt: 'document_idle',
  main() {
    createShadowUI();
    window.addEventListener('message', handleInterceptorMessage);
    setupComposerObserver();
    setupKeyboardShortcuts();

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'READING_INDICATOR') {
        setReadingActive(msg.active);
        sendResponse({ ok: true });
      }
      if (msg.type === 'SUGGESTIONS_READY') {
        suggestions = msg.suggestions ?? [];
        if (cardVisible) renderCard(false);
        sendResponse({ ok: true });
      }
      return true;
    });
  },
});
