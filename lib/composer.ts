/** Composer insertion utilities for X's tweet textarea. */

const COMPOSER_SELECTOR = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON_SELECTOR = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';

export function findComposer(): HTMLElement | null {
  return document.querySelector(COMPOSER_SELECTOR) as HTMLElement | null;
}

export function findPostButton(): HTMLButtonElement | null {
  return document.querySelector(POST_BUTTON_SELECTOR) as HTMLButtonElement | null;
}

/** Verify Post button is enabled after insert. */
export function isPostButtonEnabled(): boolean {
  const btn = findPostButton();
  if (!btn) return false;
  const disabled = btn.getAttribute('aria-disabled');
  return disabled !== 'true' && !btn.disabled;
}

function getEditableElement(composer: HTMLElement): HTMLElement {
  const editable =
    composer.querySelector<HTMLElement>('[contenteditable="true"]') ??
    composer.querySelector<HTMLElement>('[data-lexical-editor="true"]') ??
    composer.querySelector<HTMLElement>('.public-DraftEditor-content');
  return editable ?? composer;
}

function getComposerText(): string {
  const composer = findComposer();
  if (!composer) return '';
  return composer.textContent ?? '';
}

/** Normalize whitespace for reliable content comparison. */
function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function composerMatches(text: string): boolean {
  return norm(getComposerText()) === norm(text);
}

function composerHasContent(): boolean {
  return norm(getComposerText()).length > 0;
}

/** Clear existing composer text so insert replaces rather than appends. */
function clearComposerContent(composer: HTMLElement): void {
  const editable = getEditableElement(composer);
  editable.focus();

  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection.addRange(range);
  }

  document.execCommand('selectAll', false);
  document.execCommand('delete', false);
}

function focusEditable(composer: HTMLElement): HTMLElement {
  const editable = getEditableElement(composer);
  editable.focus();

  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    selection.addRange(range);
  }

  return editable;
}

/** Focus the reply composer and place the caret at the end. */
export function focusComposer(): boolean {
  const composer = findComposer();
  if (!composer) return false;
  focusEditable(composer);
  const editable = getEditableElement(composer);
  return (
    document.activeElement === editable ||
    editable.contains(document.activeElement) ||
    composer.contains(document.activeElement)
  );
}

/** Primary: synthetic paste event on the contenteditable target. */
export function insertViaPaste(element: HTMLElement, text: string): boolean {
  const editable = focusEditable(element);

  const dt = new DataTransfer();
  dt.setData('text/plain', text);

  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  });

  editable.dispatchEvent(pasteEvent);
  return composerMatches(text);
}

/** Lexical / modern editors: beforeinput + input with insertText. */
export function insertViaBeforeInput(element: HTMLElement, text: string): boolean {
  const editable = focusEditable(element);

  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  });

  if (!editable.dispatchEvent(beforeInput)) return false;

  editable.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
      data: text,
    }),
  );

  return composerMatches(text);
}

/** Fallback: execCommand insertText on the contenteditable. */
export function insertViaExecCommand(element: HTMLElement, text: string): boolean {
  const editable = focusEditable(element);
  const success = document.execCommand('insertText', false, text);
  return success && composerMatches(text);
}

type InsertMethod = 'paste' | 'beforeInput' | 'execCommand';

/** Fill composer with text — paste primary, beforeinput + execCommand fallbacks. */
export function fillComposer(text: string): { success: boolean; method?: InsertMethod } {
  return insertIntoComposer(text);
}

/**
 * Insert text into composer. Clears first, then tries one method at a time.
 * Stops after the first verified success — never falls through if content was added.
 */
export function insertIntoComposer(text: string): {
  success: boolean;
  method?: InsertMethod;
} {
  const composer = findComposer();
  if (!composer) return { success: false };

  focusComposer();
  clearComposerContent(composer);

  if (insertViaPaste(composer, text)) {
    return { success: true, method: 'paste' };
  }
  // Paste may have inserted via Lexical/React even when verification lags — do not retry.
  if (composerHasContent()) {
    return { success: composerMatches(text), method: 'paste' };
  }

  clearComposerContent(composer);
  if (insertViaBeforeInput(composer, text)) {
    return { success: true, method: 'beforeInput' };
  }
  if (composerHasContent()) {
    return { success: composerMatches(text), method: 'beforeInput' };
  }

  clearComposerContent(composer);
  if (insertViaExecCommand(composer, text)) {
    return { success: true, method: 'execCommand' };
  }

  return { success: composerMatches(text), method: composerHasContent() ? 'execCommand' : undefined };
}

/** Copy to clipboard (requires clipboardWrite permission + user gesture). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Detect if composer is Draft.js or Lexical. */
export function detectComposerEngine(): 'draft' | 'lexical' | 'unknown' {
  const el = findComposer();
  if (!el) return 'unknown';
  if (el.closest('.DraftEditor-root')) return 'draft';
  if (el.closest('[data-lexical-editor]')) return 'lexical';
  return 'unknown';
}

export function isComposerFocused(): boolean {
  const composer = findComposer();
  if (!composer) return false;
  return document.activeElement === composer || composer.contains(document.activeElement);
}
