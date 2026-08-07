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

/**
 * Visible composer text, excluding X's placeholder mirror nodes.
 * Placeholder text made `composerHasContent()` true on first open and drove a synthetic
 * delete that desynced Lexical — typing still worked, Backspace did not.
 */
function getComposerText(): string {
  const composer = findComposer();
  if (!composer) return '';
  const editable = getEditableElement(composer);
  const clone = editable.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      '[data-testid="placeholder"], [class*="placeholder"], [class*="Placeholder"]',
    )
    .forEach((n) => n.remove());
  return (clone.textContent ?? '').replace(/\u200B/g, '');
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

function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

async function waitAnimationFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

/**
 * True when the live selection roughly covers the editable's visible text.
 * Draft.js often ignores DOM selectAll unless this is actually true — paste then appends
 * (post-fix log: afterClearLen stayed 65, paste produced 116 doubled).
 */
function selectionCoversEditable(editable: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const selected = norm(sel.toString()).length;
  const content = norm((editable.textContent ?? '').replace(/\u200B/g, ''));
  if (content.length === 0) return true;
  return selected >= Math.max(1, content.length - 2);
}

/**
 * Select all editor contents. Returns whether the selection actually covers the text.
 * Draft requires a real covering selection; otherwise paste/beforeinput append at the caret.
 */
function selectAllInEditable(editable: HTMLElement): boolean {
  editable.focus();
  const selection = window.getSelection();
  if (!selection) return false;

  const texts: Text[] = [];
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.textContent ?? '').length > 0) texts.push(node as Text);
  }

  if (texts.length > 0) {
    const range = document.createRange();
    range.setStart(texts[0], 0);
    const last = texts[texts.length - 1];
    range.setEnd(last, last.length);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    try {
      selection.setBaseAndExtent(editable, 0, editable, editable.childNodes.length);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  if (selectionCoversEditable(editable)) return true;

  try {
    selection.setBaseAndExtent(editable, 0, editable, editable.childNodes.length);
  } catch {
    /* ignore */
  }
  if (selectionCoversEditable(editable)) return true;

  document.execCommand('selectAll', false);
  if (selectionCoversEditable(editable)) return true;

  const apple = isApplePlatform();
  const mod = { ctrlKey: !apple, metaKey: apple, bubbles: true, cancelable: true };
  editable.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, which: 65, ...mod }),
  );
  editable.dispatchEvent(
    new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', keyCode: 65, which: 65, ...mod }),
  );
  return selectionCoversEditable(editable);
}

/**
 * Clear composer via editor-owned beforeinput deletes only (no execCommand delete).
 * Retries until empty or attempts exhausted. Returns whether the composer is empty.
 */
async function clearComposerContent(composer: HTMLElement): Promise<boolean> {
  if (!composerHasContent()) return true;

  const editable = getEditableElement(composer);

  for (let attempt = 0; attempt < 5; attempt++) {
    const covered = selectAllInEditable(editable);

    if (covered) {
      editable.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'deleteByCut',
        }),
      );
      if (composerHasContent()) {
        selectAllInEditable(editable);
        editable.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'deleteContentBackward',
          }),
        );
      }
    } else {
      // Selection never covered — delete from caret (usually end) line by line.
      editable.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'deleteSoftLineBackward',
        }),
      );
      editable.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'deleteHardLineBackward',
        }),
      );
      editable.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'deleteContentBackward',
        }),
      );
    }

    await waitAnimationFrames(1);
    if (!composerHasContent()) return true;
  }

  return !composerHasContent();
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

/** Plan §5 / F11: text in the DOM is not enough — Post must actually be enabled. */
function insertLooksSuccessful(text: string): boolean {
  return composerMatches(text) && isPostButtonEnabled();
}

/**
 * Prepare a replace selection (select-all), not caret-at-end.
 * Paste / insertText then overwrite the selection instead of appending.
 */
function prepareReplaceSelection(composer: HTMLElement): { editable: HTMLElement; covered: boolean } {
  const editable = getEditableElement(composer);
  const covered = selectAllInEditable(editable);
  return { editable, covered };
}

function dispatchPaste(editable: HTMLElement, text: string): boolean {
  const dt = new DataTransfer();
  dt.setData('text/plain', text);

  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  });

  return editable.dispatchEvent(pasteEvent);
}

/** Primary: synthetic paste event on the contenteditable target. */
export function insertViaPaste(element: HTMLElement, text: string): boolean {
  const { editable } = prepareReplaceSelection(element);
  dispatchPaste(editable, text);
  return insertLooksSuccessful(text);
}

/** Lexical / modern editors: beforeinput + input with insertText. */
export function insertViaBeforeInput(element: HTMLElement, text: string): boolean {
  const { editable } = prepareReplaceSelection(element);

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

  return insertLooksSuccessful(text);
}

/**
 * Dispatch insertText beforeinput and report whether the editor claimed it.
 * Draft.js preventDefaults this when it handles the insert — callers MUST NOT
 * fall through to execCommand afterward (proven double-paste + dead Backspace).
 */
function dispatchInsertTextBeforeInput(editable: HTMLElement, text: string): {
  editorHandled: boolean;
} {
  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  });
  const notCanceled = editable.dispatchEvent(beforeInput);
  if (!notCanceled) {
    return { editorHandled: true };
  }
  editable.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
      data: text,
    }),
  );
  return { editorHandled: false };
}

/** Fallback: execCommand insertText — ONLY for unknown non-Draft/non-Lexical engines. */
export function insertViaExecCommand(element: HTMLElement, text: string): boolean {
  prepareReplaceSelection(element);
  const success = document.execCommand('insertText', false, text);
  return success && insertLooksSuccessful(text);
}

type InsertMethod = 'paste' | 'beforeInput' | 'execCommand';

/** Fill composer with text — paste primary, beforeinput + execCommand fallbacks. */
export async function fillComposer(text: string): Promise<{ success: boolean; method?: InsertMethod }> {
  return insertIntoComposer(text);
}

function insertSucceeded(text: string): boolean {
  return insertLooksSuccessful(text) || composerMatches(text);
}

/**
 * Insert text into the composer.
 *
 * Runtime evidence (session d72744): live X composer is Draft.js
 * (`public-DraftEditor-content`), not Lexical. Paste is a no-op; beforeinput is
 * preventDefault'd by Draft; falling through to execCommand wrote DOM text Draft
 * does not own → Backspace defaultPrevented with textChanged:false, and stacked
 * methods produced double text.
 *
 * Draft/Lexical: paste and/or beforeinput only — never execCommand.
 */
export async function insertIntoComposer(text: string): Promise<{
  success: boolean;
  method?: InsertMethod;
}> {
  const composer = findComposer();
  if (!composer) return { success: false };

  const engine = detectComposerEngine();

  // --- Lexical: select-all + paste only ---
  if (engine === 'lexical') {
    if (composerHasContent()) {
      await clearComposerContent(composer);
    }
    const { editable } = prepareReplaceSelection(composer);
    dispatchPaste(editable, text);
    await waitAnimationFrames(2);
    if (insertSucceeded(text)) {
      focusEditable(composer);
      return { success: true, method: 'paste' };
    }
    await waitAnimationFrames(2);
    const matched = composerMatches(text);
    focusEditable(composer);
    return { success: matched, method: 'paste' };
  }

  // --- Draft.js (proven live) + unknown: editor-owned events only ---
  // Synthetic deleteByCut often fails even with a covering selection; paste with
  // covering selection still replaces (post-fix: afterClearLen stayed non-zero,
  // paste matched with doubled:false).
  if (composerHasContent()) {
    await clearComposerContent(composer);
    await waitAnimationFrames(1);
  }

  // 1) Paste — only when empty OR selection covers existing text (else append = double).
  {
    const { editable, covered } = prepareReplaceSelection(composer);
    const canReplace = !composerHasContent() || covered;
    if (canReplace) {
      dispatchPaste(editable, text);
      await waitAnimationFrames(2);
      if (insertSucceeded(text)) {
        focusEditable(composer);
        return { success: true, method: 'paste' };
      }
    }
  }

  // 2) beforeinput insertText — Draft preventDefaults when it handles this.
  //    MUST NOT fall through to execCommand if editorHandled (session d72744 proof).
  {
    const { editable, covered } = prepareReplaceSelection(composer);
    if (!(composerHasContent() && !covered)) {
      const { editorHandled } = dispatchInsertTextBeforeInput(editable, text);
      await waitAnimationFrames(2);

      if (insertSucceeded(text) || (editorHandled && composerMatches(text))) {
        focusEditable(composer);
        return { success: composerMatches(text) || insertLooksSuccessful(text), method: 'beforeInput' };
      }

      if (editorHandled) {
        await waitAnimationFrames(2);
        const matched = composerMatches(text);
        focusEditable(composer);
        return { success: matched, method: 'beforeInput' };
      }
    }
  }

  // 3) execCommand ONLY if the editor never claimed beforeinput (true unknown).
  //    Never for Draft — detect again in case class markers appear mid-call.
  if (engine === 'draft' || detectComposerEngine() === 'draft') {
    focusEditable(composer);
    return { success: composerMatches(text), method: 'beforeInput' };
  }

  await clearComposerContent(composer);
  if (insertViaExecCommand(composer, text)) {
    return { success: true, method: 'execCommand' };
  }
  return {
    success: insertLooksSuccessful(text),
    method: composerHasContent() ? 'execCommand' : undefined,
  };
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
  if (
    el.closest('.DraftEditor-root') ||
    el.classList.contains('public-DraftEditor-content') ||
    el.closest('.public-DraftEditor-content')
  ) {
    return 'draft';
  }
  if (el.querySelector('[data-lexical-editor]') || el.closest('[data-lexical-editor]')) {
    return 'lexical';
  }
  // contenteditable under tweetTextarea is Lexical on some X builds.
  if (el.querySelector('[contenteditable="true"]')) return 'lexical';
  if (el.getAttribute('contenteditable') === 'true' && !el.className.includes('Draft')) {
    return 'lexical';
  }
  return 'unknown';
}

export function isComposerFocused(): boolean {
  const composer = findComposer();
  if (!composer) return false;
  return document.activeElement === composer || composer.contains(document.activeElement);
}
