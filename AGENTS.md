# AGENTS.md — X Reply Copilot

## Project identity

A WXT + TypeScript Chrome MV3 extension that suggests X (Twitter) replies in the user's own measured
voice. Human-in-the-loop by design: it drafts, the user edits and posts. Four execution contexts —
MAIN-world GraphQL interceptor, ISOLATED-world content script, service worker, options page.

## Read these before any change

1. **`docs/IMPLEMENTATION_GUIDELINES.md`** — the binding engineering contract. Non-optional.
2. **`docs/ARCHITECTURE.md`** — the authoritative current-state analysis, including findings F1-F23.

Do not start editing before reading both. The guidelines document exists because a previous wave of work
drifted from the plan, repaired four real bugs inside a module that was never executing, and shipped
changes that were not traceable to any stated intent.

## Non-negotiable invariants

Violating any of these rejects the change regardless of what else it achieves. Full text and grounding in
`docs/IMPLEMENTATION_GUIDELINES.md` §2.

1. **Never auto-post.** No code may activate X's Post button. The human tapping the screen is both the
   compliance story and the security control.
2. **No official X API, no developer account, ever.** Economically dead and legally net-negative.
3. **Passive interception only.** Zero extra network requests to x.com. The extension reads responses X
   already fetched.
4. **The BYO API key never reaches a content script or the page realm, never `chrome.storage.sync`, and
   never any destination but the user's chosen model provider.**
5. **Shadow DOM UI, zero `web_accessible_resources`, no `chrome-extension://` URL in the page DOM.**
6. **The GraphQL operation-name allowlist is consulted BEFORE any response body is parsed.** The host
   permission grants access to DMs and drafts; the allowlist is the entire privacy claim.
7. **Untrusted content never enters the instruction channel** — post text, replies, handles, and image
   descriptions are fenced or strictly validated.
8. **The in-UI data-collection disclosure and "reading this post" indicator stay visible.**

## The three rules that cause the most damage when broken

- **Prove the module executes before debugging it.** The original `interceptor.main.ts` was
  `defineUnlistedScript` and never ran; four real bugs were fixed inside it across three rounds while
  the user re-reported failure each time. It is now `entrypoints/interceptor.content.ts`, registered
  MAIN-world at `document_start` (Wave 1 / F1). Manifest registration is statically verified; live
  x.com behaviour is still awaiting observation — see `docs/ARCHITECTURE.md` F1.
- **Never trust a status marker, a todo, a README, or a previous summary over the code.** Twelve todos were
  marked complete; five are not implemented as specified.
- **Never claim a fix works without naming the observable and observing it.** "Should be fixed" is a
  hypothesis and must be labelled as one.

## Every change carries five fields

Which plan item or finding it serves, quoted. What the code currently does, with `file:line` you personally
read. The blast radius across the four execution contexts. The concrete observable that will prove it. And
whether it advances the plan or is incidental — incidental changes need justification or get dropped.

## Where to start

`docs/IMPLEMENTATION_GUIDELINES.md` §9 is the prioritized remediation backlog, in binding order. Work from
it rather than inventing a task list. Status lines on each item are the live tracker.

## Build and check

```powershell
npm run build       # typecheck then wxt build — fails if tsc or MAIN-world interceptor hooks regress
npm run typecheck   # tsc --noEmit — baseline: 0 first-party errors [verified 2026-08-06 / Wave 3]
```

There is a `typecheck` script; it is chained into `build` (`"build": "npm run typecheck && wxt build"`).
There is still no `lint` script and no test suite. ESLint was skipped during item 14 (would have
downgraded WXT/Vite via a then-existing version mismatch).

The bar is **zero** first-party `tsc` errors — cleared in Wave 3 (was three: `content.ts` TS2769,
`composer.ts` TS6133, `dom-post-brief.ts` TS7022). Re-run `npm run typecheck` before changing that claim.

`package.json` pins `"wxt": "^0.20.27"`. The lockfile root entry may still record `^0.20.7` until the
next `npm install`; installed `node_modules/wxt` is 0.20.27.
