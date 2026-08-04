# Manual Verification Checklist

Empirical checks from plan section 8. **Do not automate these against live x.com** — run manually in DevTools during normal use.

## Prerequisites

- Extension loaded unpacked from `.output/chrome-mv3`
- Valid Gemini API key configured in Options
- Logged into X on x.com

---

## 1. execCommand Outside User Gesture

**Question:** Does `document.execCommand('insertText')` return `true` outside a user gesture on X's composer?

**Steps:**
1. Open a post and click Reply to open the composer
2. In DevTools Console (page context, not extension):
   ```javascript
   const el = document.querySelector('[data-testid="tweetTextarea_0"]');
   el.focus();
   document.execCommand('insertText', false, 'test insert');
   ```
3. Record whether text appeared and whether `execCommand` returned `true`
4. Repeat from extension content script context via a temporary debug hook

**Pass criteria:** Document which path works (synthetic paste vs execCommand). Extension ships both; verify Post button `aria-disabled` after each method.

---

## 2. Draft.js vs Lexical Composer

**Question:** Is X's composer Draft.js or Lexical today?

**Steps:**
1. Open reply composer on x.com
2. Run in Console:
   ```javascript
   !!document.querySelector('[data-testid="tweetTextarea_0"]')?.closest('.DraftEditor-root')
   ```
3. Also check:
   ```javascript
   !!document.querySelector('[data-testid="tweetTextarea_0"]')?.closest('[data-lexical-editor]')
   ```

**Pass criteria:** Record which editor framework is active. Update composer selectors if needed.

---

## 3. is_pasted / composition_source Behavior

**Question:** Does synthetic paste vs `insertText` correlate with different X telemetry?

**Steps:**
1. Insert a reply via extension card click (synthetic paste path)
2. Post manually (do NOT auto-send from extension)
3. Repeat with execCommand fallback only (temporarily disable paste path in dev build)
4. Compare reach/visibility if observable (qualitative — no spoofing)

**Pass criteria:** Document observed behavior. Do not spoof telemetry.

---

## 4. Gemini Video Token Rate

**Question:** What is the actual token count for a video poster frame vs MP4 clip?

**Steps:**
1. In service worker DevTools or a test script, call Gemini `countTokens` on:
   - A `pbs.twimg.com` poster webp (`name=small`)
   - A low-bitrate MP4 variant from `video.twimg.com`
2. Compare against Google docs (263 tok/s vs 70 tok/frame discrepancy)

**Pass criteria:** Record actual counts. Decide whether 3-keyframe canvas path is needed.

---

## 5. Reranker Calibration at 40 Words

**Question:** Does character trigram cosine + exemplar distance rank your own held-out replies sensibly at ~40 words?

**Steps:**
1. Harvest 20+ own replies via profile scroll
2. Hold out 5 replies
3. Generate 5 Compose candidates for a test post
4. Inspect Stage 3 rerank scores in service worker console logs
5. Verify top-ranked candidate matches your voice better than random baseline

**Pass criteria:** Subjective pass if top suggestion "sounds like you" on 3/5 test posts.

---

## 6. Fetch Proxy Stealth

**Steps:**
1. On x.com Console:
   ```javascript
   Function.prototype.toString.call(fetch)
   ```
2. Expected: `"function fetch() { [native code] }"`

**Pass criteria:** Native toString preserved via ES6 Proxy.

---

## 7. Shadow DOM Isolation

**Steps:**
1. Open reply composer with suggestions visible
2. Inspect Elements panel — card should be inside closed Shadow DOM
3. Search DOM for `chrome-extension://` URLs

**Pass criteria:** Zero extension URLs in page DOM.

---

## 8. GraphQL Allowlist

**Steps:**
1. Open Network tab, filter Fetch/XHR
2. Browse home timeline, open a post, scroll profile replies, post a reply
3. Confirm extension only reacts to: `TweetDetail`, `HomeTimeline`, `UserTweetsAndReplies`, `CreateTweet`
4. Confirm DMs and other operations are ignored

**Pass criteria:** No postMessage traffic for non-allowlisted operations.

---

## 9. Post Button aria-disabled After Insert

**Steps:**
1. Click a suggestion card (or ⌘1)
2. Immediately inspect:
   ```javascript
   document.querySelector('[data-testid="tweetButton"]')?.getAttribute('aria-disabled')
   ```
3. Expected: `"false"` (Post button enabled)

**Pass criteria:** Post button enabled after insert on 3 consecutive attempts.

---

## 10. Rate Governor UI

**Steps:**
1. Set daily budget to 5 in Options
2. Generate 5 suggestions across different posts
3. Verify warning appears on 6th attempt
4. Reply to same account 4+ times — verify nudge message

**Pass criteria:** Hard budget enforced; per-account nudge visible.

---

## 11. Disclosure Indicator

**Steps:**
1. Navigate to any post detail page
2. Verify "📖 Reading this post" pill appears bottom-right
3. Navigate away — indicator should disappear

**Pass criteria:** Indicator visible during post analysis.

---

## 12. StyleCard Flywheel

**Steps:**
1. Post 50 replies (or manually trigger via `REGENERATE_STYLE_CARD` in Options)
2. Compare StyleCard before/after in Options
3. Check IndexedDB `x-reply-copilot` → `diffs` store for suggestion/posted pairs

**Pass criteria:** StyleCard updates; diffs stored with non-trivial diff ratios when suggestions edited before posting.
