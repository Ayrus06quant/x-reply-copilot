# X Reply Copilot — Implementation Guidelines

**Status: binding contract. Version 1.0, dated 2026-08-06.**

Every change to this repository from this date forward must comply with this document. It exists because
the previous wave of work drifted from the agreed plan, repaired bugs inside a module that was never
executing, and shipped changes that were not traceable to any stated intent. The rules below are designed
to make each of those failure modes structurally impossible rather than merely discouraged.

## Sources this document is grounded in

| Tag | Source | Location |
|---|---|---|
| `[plan §N]` / `[plan todo:id]` | The original agreed design and build plan, quoted verbatim | `C:\Users\surya\.cursor\projects\d-X-agent\uploads\x_reply_copilot_536d4df2.plan-L1-L184-0.md` |
| `[F1]`…`[F23]` | Findings from the current-state analysis | `docs/ARCHITECTURE.md` §10 |
| `[D1]`…`[D10]` | Recorded deviations from the plan | `docs/ARCHITECTURE.md` §9 |
| `[user]` | A verbatim user statement | Quoted inline wherever used |
| `[verified 2026-08-06]` | A claim re-verified by reading the code or running a command on this date | `file:line` given inline |

The twelve plan item ids are `scaffold`, `interceptor`, `media`, `generate-v1`, `card-ui`, `corpus`,
`voice`, `rerank`, `prefetch`, `flywheel`, `governor`, `verify`. There is no thirteenth. If a proposed
change does not serve one of these twelve or a numbered finding, see §3.5.

A note on line numbers: `lib/composer.ts` and `lib/dom-post-brief.ts` are stored with corrupted `\r\r\n`
line terminators, so `tsc` reports roughly `2N-1` for those two files `[F14]`. Line numbers in this
document are logical line numbers as the file reads.

---

## 1. Purpose, and how to use this document

**Read this before every change. Cite it in every change. Never infer user or plan intent — quote it.**

The workflow is three steps and there is no shortcut past any of them.

1. **Before writing code**, read this document and the relevant section of `docs/ARCHITECTURE.md`. Identify
   which plan item or finding your change serves and copy the exact wording into your change description.
2. **While writing code**, verify the current behaviour by reading the code, not by trusting a status
   marker, a comment, a doc, or a previous agent's summary (§4).
3. **Before claiming completion**, state the concrete observable that proves the change works, and
   observe it (§8).

If you cannot find a grounded source for something you want to do, you have two honest options: ask the
user (§11), or write it down as unverified and do not ship behaviour that depends on it. **Marking an
assumption as an assumption is always acceptable. Presenting an assumption as a fact is not.**

This document does not describe the code as it should be. It describes the code as it *is*, plus the
rules for changing it. Where the two disagree, §9 is the reconciliation plan.

---

## 2. Non-negotiable product invariants

These are not preferences. Each one is either a compliance argument, a security control, or a cost
argument that the entire product design rests on. A change that violates any of them is rejected
regardless of what else it achieves.

### I1. Never auto-post. The human always taps.

`[plan §5]`, verbatim: *"**Never auto-send** — the human is both the compliance story and the security
control."*

`[plan §1]`, on why: *"X's head of product has stated three times in 2026 that the test is whether a
human is tapping the screen, and explicitly blessed AI for proofreading and editing while removing 42,000
accounts for automated replies."*

**Current state `[verified 2026-08-06]`:** compliant. No code path submits a reply. The most privileged
DOM action in the repository is inserting text into a contenteditable (`lib/composer.ts:155-187`).

**Rule:** no code may click, dispatch to, or otherwise activate X's Post button. No queueing, no
scheduling, no bulk features. `[plan §5]`: *"Deliberately do not build bulk or queue features."*

### I2. No official X API. No developer account. Ever.

`[plan §1]`, verbatim: *"Since February 2026 it is pay-per-use at $0.005 per post read with no free tier.
One post plus its top 20 replies is about $0.11 in X fees alone; at 50 replies/day that is $165-300/month
per user before any LLM cost. Registering a developer account is also net-negative legally: it binds you
to a second Texas forum-selection clause and to Developer Policy language prohibiting "intercept[ing]" X
features. **Never register an X developer account for this product.**"*

**Rule:** no `api.x.com`, no `api.twitter.com`, no OAuth flow against X, no bearer token, no developer
credential of any kind. Approach C in `[plan §2]` was rejected and the rejection is recorded so it is not
re-litigated.

### I3. Passive interception only. Zero extra network requests to X.

`[plan §1]`, verbatim: *"A `document_start` MAIN-world script that proxies `window.fetch` reads X's own
GraphQL responses as you browse. Zero additional requests."*

**Rule:** the extension reads responses X's own bundle already requested. It never issues a request to
`x.com` or `/i/api/graphql/`. The only outbound requests the extension may make are (a) to the chosen
model provider and (b) to `pbs.twimg.com` for image bytes, which `[plan §3]` explicitly permits: *"images:
`pbs.twimg.com` needs no auth and reflects any `Origin` into its CORS header."*

**Current state `[verified 2026-08-06]`:** `wxt.config.ts:10-16` declares exactly five host permissions —
`x.com`, `twitter.com`, `pbs.twimg.com`, `video.twimg.com`, `generativelanguage.googleapis.com`. No X API
host is present.

### I4. The BYO API key lives in `chrome.storage.local` and reaches only the chosen provider.

`[plan §5]`, verbatim: *"Key lives only in the service worker via `chrome.storage.local`, never `sync`
(which uploads to Google), never in the content script, never in the page. All provider calls originate
from the SW."*

**Current state `[verified 2026-08-06]`:** partially violated, deliberately and with a recorded reason.
`chrome.storage.sync` is never used — compliant. But the Options page reads the key into React state
(`entrypoints/options/App.tsx:124`) and calls the provider directly from the page context
(`App.tsx:192`), because validation against a sleeping MV3 service worker failed silently and blocked
onboarding `[D8]`, `[F16]`.

**Rule, split into the part that is absolute and the part that is negotiable:**

- **Absolute:** the key must never reach a content script or the x.com page realm. It must never be
  written to `chrome.storage.sync`. It must never be sent anywhere except the user's chosen provider
  endpoint. No telemetry, no error reporting, no third party.
- **Negotiable, and currently in violation:** the options-page exception. Either the guarantee in
  `README.md:70-71` is corrected to describe the real trust boundary, or validation moves back behind the
  worker now that `lib/messaging.ts` has a working wake-and-retry. See backlog item 15 and §11 Q2.

### I5. Shadow DOM UI. Zero `web_accessible_resources`. No `chrome-extension://` URL in the page DOM.

`[plan §5]`, verbatim: *"ES6 Proxy for the fetch patch so `Function.prototype.toString.call(fetch)` still
reads native; Shadow DOM UI; zero `web_accessible_resources` (or `use_dynamic_url: true`); no
`chrome-extension://` URL ever in the DOM."*

**Current state `[verified 2026-08-06]`:** compliant. The card lives in a closed shadow root
(`entrypoints/content.ts:343`) with styles inlined at `content.ts:372-374` rather than linked. The
generated manifest at `.output/chrome-mv3/manifest.json` contains no `web_accessible_resources` key and no
`scripting` permission.

**Rule:** `[F1]` was fixed by registering the interceptor as a manifest-declared MAIN-world content
script — that path satisfies I5. Adding `web_accessible_resources` plus `injectScript` does not, because
it places an extension URL in the page. If a future change genuinely needs `web_accessible_resources`,
`use_dynamic_url: true` is the only acceptable form, and it requires explicit user sign-off first.

### I6. The operation-name allowlist is consulted BEFORE any response body is parsed.

This is the privacy claim the whole design rests on. `[plan §5]`, verbatim: *"`https://x.com/*` host
permission grants access to DMs and drafts. The interceptor matches an explicit list of GraphQL operation
names and hard-drops everything else. That allowlist is the auditable privacy story."*

**Current state `[verified 2026-08-06]`:** compliant in code after Wave 1 / backlog item 2 (`[F7]`
resolved). `classify(url, init)` in `entrypoints/interceptor.content.ts` decides compose / create /
harvest / drop from the URL and request init alone; the body is read only after that decision. Runtime
sets derive from `COMPOSE_OPERATIONS` / `HARVEST_OPERATIONS` in `lib/types.ts` (`[F20]`). Live x.com
drop-without-parse behaviour is still unobserved — see the F7 resolution note in
`docs/ARCHITECTURE.md`.

**Rule:** the very first thing the GraphQL handler does, after extracting the operation name, is
decide whether that operation is allowed. If it is not, return without touching the body. No `.json()`,
no `.clone()`, no viewer-identity sweep, no logging of payload contents. This is not an optimisation; it
is the difference between the disclosure being true and being nearly true.

### I7. Untrusted content never enters the instruction channel.

`[plan §5]`, verbatim: *"post content never enters the instruction channel, only a fenced untrusted-data
block; Stage 1 emits structured JSON so injected text cannot survive verbatim into Stage 2; and the output
gate strips all URLs, strips any @handle not present in the source thread, and hard-caps length."*

**Current state `[verified 2026-08-06 / Wave 3]`:** compliant in code for the named holes.
`fenceUntrusted` (`lib/prompts.ts:14-21`) wraps content and neutralizes embedded `<untrusted_*>` /
`</untrusted_*>` sequences to `[fence]`. Claim, tone, post text, image description, top replies, and
`repliesAlreadySaid` are fenced (Wave 1 / item 5). Author handle is strictly validated via
`sanitizeAuthorHandle` against `/^[A-Za-z0-9_]{1,15}$/` before interpolation (`prompts.ts:133-135`,
`:142`, `:157`) — Wave 3 / `[F9]` closed. Live prompt-dump proof still outstanding.

**Rule:** every field that originated outside the extension is fenced or strictly validated before it
reaches a prompt. Adding a new field to a prompt requires stating which category it is in.

### I8. The data-collection disclosure stays visible in the extension UI.

`[plan §5]`, verbatim: *"Chrome Web Store, enforced since August 1 2026. Reading the post you are viewing
counts as collecting browsing activity, permitted only if the feature is prominently described both on the
store listing *and in the extension UI*. Ship a visible "reading this post" indicator as a first-class
requirement."*

**Current state `[verified 2026-08-06]`:** compliant in substance. Static disclosure text in the card
(`content.ts:352`) and in Options (`App.tsx:823-829`), plus a live "Reading this post" indicator
(`content.ts:349`, `:503-509`). No affirmative acceptance gate exists, though `README.md:36` claims one
`[F19]`.

**Rule:** no change may remove or hide the reading indicator or the disclosure text. Whether an
affirmative gate is required is §11 Q3.

---

## 3. The grounded-change protocol

Every code change — including one-line changes, including changes you consider obviously correct — carries
the following five fields. If a field cannot be filled honestly, the change does not ship.

### 3.1 (a) Which plan item or finding does this serve, quoted?

Name the plan item id or finding id, and paste the exact wording. Not a paraphrase.

Acceptable: *"Serves `[plan todo:prefetch]`: 'Split into Comprehend (multimodal, on post-open,
session-cached by tweet ID) and Compose (text-only, on reply click).' The 'on post-open' half is currently
unachievable, per `[F1]`."*

Not acceptable: *"Improves prefetch."* / *"Part of the latency work."* / *"Cleanup."*

### 3.2 (b) What does the current code actually do — verified by reading it?

State the current behaviour with `file:line` references you personally opened. **A todo marked
`completed`, a status table, a doc claim, or a previous agent's summary is not evidence.**

The cautionary case is on the record. `docs/ARCHITECTURE.md` §8 notes: *"the build agent marked all twelve
todos `completed`, and the summary reported 'All 12 plan todos are done' — at a point when passive
harvesting had never once worked for the user, and never did across the remainder of the conversation."*
Five of those twelve are verifiably not implemented as specified.

### 3.3 (c) What is the blast radius across execution contexts?

There are four isolated JavaScript environments in this extension and they fail independently. Any change
must state which it touches and what it means for the others.

| Context | Where | Has `chrome.*`? | Reaches the page realm? | Notes |
|---|---|---|---|---|
| MAIN world | `entrypoints/interceptor.content.ts` (`world: 'MAIN'`, `document_start`; manifest-registered Wave 1 / `[F1]`) | No | Yes | Only `window.postMessage` out. Must stay at `document_start` or the `fetch` patch is too late. |
| ISOLATED world | `entrypoints/content.ts` (`content.ts:629-631`, `document_idle`) | Yes | Shares DOM, not realm | All UI and all messaging. The key must never reach here. |
| Service worker | `entrypoints/background.ts` | Yes | No | Holds the key, owns IndexedDB and the governor. Killed after ~30s idle; module-level state is lost (`lib/gemini.ts:761-764`). |
| Options page | `entrypoints/options/*` | Yes | No | A first-party extension page. Currently also makes provider calls directly `[F16]`. |

Specific traps to check every time:

- **Message protocol changes** touch `lib/types.ts`, the sender, and `entrypoints/background.ts` at once.
  Three message types remain declared and handled but never sent by anyone: `VALIDATE_API_KEY`,
  `IMPORT_MANUAL_REPLIES`, `GET_CORPUS_COUNT` (`docs/ARCHITECTURE.md` §5.5). Wave 3 wired
  `GET_GOVERNOR_STATUS` (card + Options) and counts via `CREATE_TWEET` / `RECORD_POST`. Adding a
  handler is not wiring a feature.
- **`chrome.storage.session` access for content scripts** was opened in Wave 1 / `[F3]` via
  `setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })` in the service worker. Live
  proof that `served:<tweetId>` is written still outstanding (item 10).
- **IndexedDB schema has one owner** after Wave 1 / `[F5]`: `lib/corpus.ts` exports `openDb` at
  `DB_VERSION = 2`; `lib/flywheel.ts` imports it.
- **Service-worker death.** Anything cached in a module-level variable is gone on the next wake. Check
  whether your change needs a `chrome.storage.local` mirror, as `lib/gemini.ts:255-258` does for the
  working model and auth mode.
- **Never `void` a storage or messaging promise without a `.catch` that logs.** That is exactly how
  `[F3]` stayed invisible.

### 3.4 (d) How will this be verified, and what is the concrete observable?

Name the thing a human will see. "It should work now" is not an observable. Acceptable observables include:

- a specific string in a specific console at a specific moment;
- a specific key present in `chrome.storage.local` with a specific shape;
- a specific field in the generated `.output/chrome-mv3/manifest.json`;
- a measured number, with the measurement method stated;
- a checklist item in `docs/VERIFY.md`, executed, with the result written back into that file.

`docs/VERIFY.md` is a good checklist that has never been run — `[plan todo:verify]` is the only plan item
with a verdict of flatly *"Not done"* in `docs/ARCHITECTURE.md` §8, and the file records no results
anywhere. Running it and recording results counts as satisfying (d) for the items it covers.

### 3.5 (e) Does this advance the plan, or is it incidental?

State one of exactly three things:

- **Advances the plan.** Cite the item from (a).
- **Fixes a numbered finding.** Cite the finding from (a).
- **Incidental.** Then justify it in one sentence against a user statement or a plan quote, or drop it.

`[user]`: *"while changing codebase reason how will it impact the entire project and is this code change in
direct relation to our plan achievement or not"*

Refactors, renames, formatting sweeps, dependency bumps, and "while I was in there" edits are incidental by
default. Bundling an incidental change into a functional one is how blast radius becomes unreviewable. Ship
them separately or not at all. The one standing exception: deleting code that is provably dead is
pre-approved, because `[F15]` and `[F21]` establish that dead code in this repository actively misleads —
four dead exports are the *implementations* of plan requirements, and their existence is what made those
requirements look complete on a skim.

---

## 4. Anti-hallucination rules

### R1. Prove the module executes before you debug it.

This is the single most expensive lesson in this project's history, and it has a name: `[F1]`.

**Historical failure (pre-Wave 1):** `entrypoints/interceptor.main.ts` used `defineUnlistedScript`.
WXT builds unlisted scripts to a standalone bundle that the developer must inject; it does not register
them. Roughly 700 lines never ran. Four plausible causes were repaired inside that dead module while
the user re-reported failure each time — see `docs/ARCHITECTURE.md` D1 / F1.

**After Wave 1:** the entrypoint is `entrypoints/interceptor.content.ts`, registered MAIN-world at
`document_start`. Manifest registration is statically verified; live page-console execution is still
the proof that matters. `lib/perf.ts` `logEntry` is the cheap always-on signal.

**Rule:** before debugging any module, prove it runs. The cheapest proof is a one-line log at the module's
entry point plus an instruction to the user on where to look for it. If you cannot produce evidence of
execution, the module not running *is* your first hypothesis and you test it first. This still applies to
the interceptor, `lib/graphql-parser.ts`, `lib/media.ts`, `lib/post-brief.ts`, and the
`HARVEST_REPLY` / `CREATE_TWEET` paths — wired in code, live behaviour awaiting observation.

### R2. Never claim a fix works without the observable.

Permitted: "Changed X. Verify by doing Y; you should see Z." Forbidden: "Fixed." / "This should resolve
it." / "Now working." A fix without an observation is a hypothesis, and it must be labelled as one.

### R3. Never trust a status marker over the code.

Twelve todos marked `completed`; five demonstrably not implemented as specified. `README.md` was
partially reconciled 2026-08-06; `docs/VERIFY.md` still references an IndexedDB name, a store name, and
a message type that do not exist `[F19]`. The code is the only authority.

### R4. Do not re-fix what is already fixed.

Concrete live example, because a request from the user is currently pointed at code that already does the
thing. `[user]`: *"if you can pls restrict or lower the thinking mode of 2.5 flash"*.

`[verified 2026-08-06]` thinking control is already implemented and already minimal on the happy path:

- `lib/gemini.ts:449-451` — `interactionsThinkingConfig()` sends `thinking_level: 'minimal'`,
  `thinking_summaries: 'none'`.
- `lib/gemini.ts:453-456` — `generateContentThinkingConfig(model)` sends
  `thinkingConfig: { thinkingBudget: 0 }` for any model matching `/gemini-2\.5/`, and correctly returns
  `null` for 3.x models which cannot disable it.

The real latency defect was elsewhere (§5). Specifically, `isConfigRejection` catches a 400 mentioning
thinking and retries **without any thinking control**. Wave 2 / item 9 capped that fallback:
`inflatedTokenBudget` is now `min(maxTokens + 512, CONFIG_REJECTION_TOKEN_CEILING)` with
`CONFIG_REJECTION_TOKEN_CEILING = 5120` (`lib/gemini.ts:488-493`), so compose falls back at
**4608** (4096+512), logged on both routes (`:598-602`, `:714-718`). Happy-path thinking control is
unchanged and must stay untouched (§4 R4). Remaining latency work is measurement, not re-tuning thinking.

**Rule:** before implementing a requested fix, verify the fix is absent. If it is present, say so, and
redirect to the actual cause with evidence. Doing what was asked when what was asked is already done is
still a plan deviation.

### R5. Distinguish "the code cannot do this" from "this did not work when I tried it."

Static reading proves the first. Only a live run proves the second. `docs/ARCHITECTURE.md` §11 is explicit
about its own limits: *"Nothing in this review was run against a logged-in x.com session."* Whether the DOM
selectors in `lib/dom-post-brief.ts` and `lib/composer.ts` still match X's current markup, whether
synthetic paste actually commits to X's editor, and whether the composer is Draft.js or Lexical today are
all unverified. Do not upgrade them to verified without running them.

---

## 5. Performance budget

### 5.1 The target, quoted

`[plan §1]`, verbatim: *"Gemini 2.5 Flash-Lite is ~0.31s to first token, ~1.1s total for image+text, at
~$0.31 per *thousand* calls. Human motor time between deciding to reply and having hands on the keyboard is
700-1200ms. Generation that starts on post-open finishes before you ask."*

`[plan todo:prefetch]`, verbatim: *"Measure end-to-end perceived latency against the 700-1200ms motor-time
window."*

### 5.2 The current state, quoted, and why it is a defect

`[user]`: *"generation took 6-7 seconds when it should not take this much time."*

`[user]`: *"i was promised that by the time i clicked on reply the comments will already be generated"*

`[user]`: *"the comments only started generating when i clicked on reply"*

The 6-7 second figure is a user-reported measurement from before Wave 1. It is a **defect**, not a
tuning opportunity: the design premise is that generation completes before the user asks.

**Instrumentation `[verified 2026-08-06]`:** `lib/perf.ts` adds always-on `logEntry` lines and
`performance.now()` marks; totals persist to `chrome.storage.local.xrcLastPipelineTiming` (Wave 1 /
backlog item 1). **No real latency numbers exist yet** — producing them needs a live x.com session with
an API key. Prefetch-on-post-open is implemented in code (item 4) but likewise awaiting live
verification. Wave 2 / item 9 landed wall-clock, ListModels TTL, config-rejection cap, and messaging
bounds in code; `[F17]` stays open until ten warm/cold trials are recorded. Warm 700–1200 ms is
assessed as plausible but **not measured** with a live key — read `xrcLastPipelineTiming`. Cold still
likely 2–4 s.

### 5.3 What actually accumulates the 6-7 seconds

Causes below were verified at analysis time; Wave 1 / Wave 2 closed the marked rows in *code*.
Re-measure on a live session before treating any cost as current. Do not re-tune the already-minimal
thinking config (§4 R4).

| Cause | Evidence | Cost | Status |
|---|---|---|---|
| Prefetch miss forces Stage 1+2 after reply click | If Comprehend is not already in session cache, `handleCompose` awaits Stage 1 then Stage 2 | One or two full round trips | Item 4 implements post-open prefetch — **awaiting live verification** that cache is warm before click |
| Stage 1 awaited serially before Stage 2 on a cache miss | `background.ts` compose path | One full round trip | Still the miss path; warm path is the design target |
| Comprehend can itself make an extra vision round trip first | `gemini.ts` vision path (now up to 4 in parallel, item 7) | One more round trip (vision) | Mitigated in code (items 7 / 9); live cost unmeasured |
| Cold service worker adds a ListModels GET before the first generation | `callGemini` → `resolveModelOrder` | One more round trip | **Resolved in code** (item 9): `discoveredGeminiModelsAt` + 24 h TTL (`gemini.ts:272-294`, `:838-858`) — first cold after TTL expiry still pays ListModels |
| Config-rejection fallback strips thinking control and inflates the budget | `gemini.ts` config-rejection path | Was unbounded (16384); now capped | **Resolved in code** (item 9): ceiling 5120, compose fallback 4608, logged on both routes — do not re-tune happy-path thinking (§4 R4) |
| Retry fan-out is very wide | `FETCH_TIMEOUT_MS = 25_000`; models × routes × config attempts × auth modes | Was minutes | **Partially resolved in code** (item 9): abandon further model fallbacks after `COMPOSE_WALL_CLOCK_MS = 8000` (`gemini.ts:164-165`, `:910-926`). Per-attempt HTTP timeout remains 25 s — an in-flight call is not aborted mid-request |
| The whole message can be retried four times at 90s each | `messaging.ts` | Compounds the above | **Resolved in code** (item 9): COMPOSE/COMPREHEND timeout 12 s; non-transient errors break immediately (`messaging.ts:8-9`, `:125-165`). Options/admin still 90 s |
| Document-wide `MutationObserver` / script-tag scan | Was `content.ts` observing `document.body` unthrottled | Main-thread work on a virtualised timeline `[F6]` | **Resolved in code** (item 8) — Performance profile on a live timeline still outstanding |
| GraphQL body parsed before allowlist | Was the dead interceptor path | Multi-MB `.json()` per call `[F7]` | **Resolved in code** (item 2) — live drop-without-parse unobserved |
| StyleCard / gate load serial with compose | Was fully serial | Extra IndexedDB wait on the critical path | **Mitigated in code** (item 9): StyleCard + `buildGateContext` start before generation; gate await deferred until after compose (`background.ts:313-355`) |

### 5.4 Binding targets

| Budget | Value | Grounding |
|---|---|---|
| Prefetch completes before the reply click, in the common case | Comprehend for the open post must be in `chrome.storage.session` before the click | `[plan §1]` "Generation that starts on post-open finishes before you ask"; `[plan todo:prefetch]` |
| Warm compose, prefetch hit — click to card rendered | **≤ 1200 ms** | `[plan §1]` "700-1200ms" motor-time window |
| Refinement chip re-run | **≤ 1000 ms** | `[plan §6]` "Each is a ~400ms Stage 2 re-run" is the plan's figure; 1000 ms is the ceiling this document sets against it, because the plan's 400 ms assumed flash-lite and no reasoning tokens `[D2]`, `[D4]` |
| Cold compose — no prefetch, cold worker, worst realistic case | **≤ 4000 ms**, or a visible progress state plus an explicit reason | No plan figure exists for this case. This ceiling is set by this document, not quoted; treat it as a decision, not a citation. |
| Total wall clock for one compose attempt across all fallbacks | **≤ 8000 ms**, then abandon with a user-visible reason | Derived from `[F17]` "add a wall-clock budget across the whole compose path and abandon fallbacks past it" |

### 5.5 Rules

- **Instrument before optimising.** Three `performance.now()` marks — capture, comprehend complete,
  compose complete — and log the deltas. Without numbers, every latency claim is a guess. This is backlog
  item 1 and it blocks verification of items 4, 8, and 9.
- **Thinking-token minimisation on `gemini-2.5-flash` must be preserved, and the config-rejection
  fallback stay capped.** The happy path is already correct (§4 R4). Wave 2 capped
  `isConfigRejection` at 5120 tokens with logging on both routes — do not raise that ceiling or strip
  the log without measured justification.
- **Do not re-introduce unbounded budgets.** Any increase to `COMPOSE_MAX_TOKENS` (currently 4096,
  `gemini.ts:169`), `COMPREHEND_MAX_TOKENS` (2048, `:170`), `VISION_MAX_TOKENS` (512, `:171`),
  `CONFIG_REJECTION_TOKEN_CEILING` (5120, `:488`), or `COMPOSE_WALL_CLOCK_MS` (8000, `:165`) requires
  a measured justification in the change description.
- **Eliminate hot-path waste.** `[user]`: *"there would also be many unintended, dead loops, unnecessary
  checks that slow down the process so appropriately handle and eliminate them"*. The named ones are
  `[F6]` (the observer and the redundant 5s interval), the unthrottled `scroll` → `positionCard` handler
  (`content.ts:592-594`), the sequential per-reply `sendExtensionMessage` in the harvest batch loop
  (`content.ts:226-241`), and `[F7]` (parse before allowlist). Removing any of these counts as advancing
  the plan under §3.5 because a user statement grounds it.
- **Bound every retry loop.** A loop whose worst case cannot be stated in seconds is not acceptable in the
  compose path.

---

## 6. GraphQL resilience policy

`[user]`: *"X is frequently changing how you access X's graphQL, so you know you need to make it robust and
uptodate so that we and X are on the same page, X should not be able to trick us."*

### 6.1 The shape of an X GraphQL URL

```
https://x.com/i/api/graphql/<queryId>/<OperationName>
                            ^^^^^^^^^  ^^^^^^^^^^^^^^^
                            rotates    comparatively stable
```

The `s6ERr1Ux...`-style hash is the **queryId**. X regenerates it on essentially every frontend deploy.
The **OperationName** is comparatively stable, because X's own frontend code is written against those
names. This is why `[plan todo:interceptor]` specifies an operation-**name** allowlist: *"Build the GraphQL
interceptor with an explicit operation-name allowlist (TweetDetail, HomeTimeline, UserTweetsAndReplies,
CreateTweet)."*

**The plan's operation-name allowlist is correct and must be preserved.** It is simultaneously the
resilience mechanism and the privacy boundary (I6).

### 6.2 Rules

**P1. Never match on the queryId.** No hash may appear in any allowlist, regex, or comparison. If a hash
literal ever appears in the source, that is a defect on sight.

**P2. The allowlist is a single explicit list of names, in one place.**

`[verified 2026-08-06]` there are currently **two** independent definitions and they have already drifted
`[F20]`:

| Definition | Location | Contents | Used at runtime? |
|---|---|---|---|
| Declared constants | `lib/types.ts:127-145` — `COMPOSE_OPERATIONS`, `HARVEST_OPERATIONS`, `ALLOWED_OPERATIONS` | 3 compose + 5 harvest names | **No.** `isAllowedOperation` (`graphql-parser.ts:75`) has zero call sites |
| What actually runs | `lib/graphql-parser.ts:3-5` | `Set(['TweetDetail','HomeTimeline','CreateTweet'])` plus regex `/UserTweets\|Replies\|TweetsAndReplies\|ProfileTimeline\|ProfileTweets\|UserMedia\|UserWithProfile\|ProfileModules/i` | Yes |

The runtime harvest matcher is a broad regex, and a regex is not *"an explicit operation-name allowlist,"*
which is how `[plan §5]` described the auditable privacy boundary. Derive the runtime set from the
`lib/types.ts` constants; replace the harvest regex with an explicit list; delete the redundant helper.
Note the existing drift: `UserTweetsAndReplies` is in `HARVEST_OPERATIONS` but `lib/post-brief.ts:93` has a
`case 'UserTweetsAndReplies'` inside `buildPostBrief`, which is only ever called for compose operations —
a dead branch.

**P3. Allowlist check strictly before body parse.** See I6. This is the same rule stated as a privacy
invariant and repeated here as a resilience rule, because a fallback path that parses first would silently
reintroduce the violation.

**P4. Structural fallback for unrecognised names.** When an operation name is not recognised, the response
body must still not be parsed for content. The permitted fallback is shape-based recognition applied only
to responses the extension is already permitted to read — that is, a request whose *variables* identify it
as a tweet-detail or profile-timeline request (`isProfileTimelineRequest`, `graphql-parser.ts:81-88`,
already does this for `userId`), or a payload whose top-level shape matches a known tweet container. The
fallback must:

- be recorded distinctly from an allowlisted hit, so its use is visible;
- never widen the set of *URLs* whose bodies get read — a structural fallback recognises payloads within
  the already-permitted set, it does not authorise reading new ones;
- never be used for DM, draft, notification, or settings operations under any circumstances.

**P5. Telemetry on disappearance — silent breakage is forbidden.** For each allowlisted operation, record
locally whether it has been seen in the current session. When an operation the extension depends on
(`TweetDetail` above all) has not appeared within a session in which the user opened a post, that is a
first-class, surfaced condition — a console warning at minimum and a persisted marker in
`chrome.storage.local`, in the style of the existing `xrcLastGenerationDebug` record (`lib/debug.ts:84`,
`:94`). The failure mode this prevents is precisely `[F1]`: a data path that produced nothing for weeks
while every layer reported success.

**P6. Graceful degradation to the DOM path, never failure.** When GraphQL data is unavailable for any
reason, the extension falls back to `lib/dom-post-brief.ts` and continues to produce suggestions. It does
not error, and it does not block the card. The DOM path is strictly poorer — no `note_tweet` long-form
text, no `ext_alt_text`, no video variants, `topReplies: []` (`dom-post-brief.ts:75`) — so degradation must
be **visible** to the user or at least to the debug record, so nobody mistakes degraded output for a model
quality problem again.

**P7. Read every path defensively.** `[plan §5]`: *"GraphQL payload shape (the cursor field already moved
once and broke twikit and Nitter — read every path with `??`)."* The `dig()` walker
(`graphql-parser.ts:101-108`) exists for this and must be used for all nested reads. A thrown
`TypeError` inside the interceptor runs in X's own page realm and can break the host page.

---

## 7. Multimodal contract

`[user]`: *"i dont even know if our product handles images, videos, gifs well and understands them??"*

`[user]`: *"the quality of the comments was very poor, it was as if it had no context whatsoever with the
post(text,images etc)"*

`[plan todo:media]`, verbatim: *"Implement media extraction: ext_alt_text first, then pbs.twimg.com webp at
name=small with a medium-escalation heuristic, then video poster frame. Defer the 3-keyframe blob-URL
canvas path until measured as necessary."*

The deferral of the 3-keyframe canvas path is explicit in the plan and remains in force. Do not build it
without a measurement showing it is necessary.

### 7.1 GIFs are a video path, not an image path

X serves animated GIFs as looping MP4s. The DOM renders them as `<video>` elements, not `<img>`.

`[verified 2026-08-06, Wave 2 / item 7]` both paths treat GIFs as video-family:

- **GraphQL path:** `lib/media.ts:79-88` routes `animated_gif` with `video` — poster via
  `buildImageUrl(media_url_https)`, optional `videoVariants` from `video_info` when present. Never
  grouped with `photo` for description.
- **DOM path:** `lib/dom-post-brief.ts:74-94` classifies `<video poster>` as `animated_gif` when
  `isGifPosterUrl` matches `tweet_video_thumb` (`media.ts:95-97`), else `video`; may capture
  `aria-label` as alt when it is not a generic "video"/"gif" label.

**UNVERIFIED:** whether X's live GraphQL payload actually includes `video_info.variants` on
`animated_gif` entities. Code reads them when present; whether they are always populated on live
payloads requires inspecting a real response and cannot be settled by reading the repository. Do not
assert it either way until observed.

### 7.2 What must demonstrably work, and how each is proven

For each media kind, the contract is: the model receives a usable description, or the model is explicitly
told a description was unavailable. Silence is not acceptable — see 7.4.

| Media kind | Required behaviour | Observable that proves it |
|---|---|---|
| Photo with `ext_alt_text` | Alt text used directly, no vision call | Debug record shows the description equals the alt text and no vision request was issued (`gemini.ts:1012-1013`) |
| Photo without alt text | Vision call on the `pbs.twimg.com` URL at `?format=webp&name=small`, escalating to `medium` only per the plan heuristic | Debug record shows a vision request, the exact URL including `name=`, and a non-empty description reaching the compose prompt |
| Multiple photos (X allows 4) | Either all are described, or the prompt states the view is partial | The compose prompt contains either N descriptions or an explicit partial-view statement. **In code (Wave 2):** up to `MAX_DESCRIBE_MEDIA = 4` via `selectMediaForDescription` + `combineMediaDescriptions` (`media.ts:100-149`; `gemini.ts:1101-1117`; `groq.ts` same). Live four-photo proof still outstanding `[F22]` |
| Video | Poster-frame description via `media_url_https`; the 3-keyframe path stays deferred | Debug record shows a poster-frame vision call, or the explicit fallback string, and the compose prompt contains it |
| Animated GIF | Classified as a **video-family** item in both the GraphQL and DOM paths; described from its poster frame; never fetched as a still photo URL | A GIF post produces a `MediaItem` with `type: 'animated_gif'`, and the compose prompt contains a description that mentions motion or the explicit fallback. **In code (Wave 2);** live GIF proof still outstanding |
| Media present, description unavailable | The compose prompt says so explicitly | The compose prompt contains an explicit "media present, not readable" statement instead of omitting the block. **In code (Wave 2):** `MEDIA_UNREADABLE` / compose `<untrusted_post_image>` (`media.ts:103-105`, `prompts.ts:176-188`) |

The plan's sizing heuristic is implemented correctly and must be preserved: `lib/media.ts:28-39` builds
`?format=webp&name=small` and escalates to `medium` only when `sizes.large.w > 1500` **and** the post has
no text — which matches `[plan §3]` exactly: *"Escalate to `name=medium` only when `sizes.large.w > 1500`
and the post has no text, which usually means a screenshot with small type."*

### 7.3 The current failure modes, verified

Wave 2 / item 7 closed several rows in *code*. Live proof per media kind still needs the user.

| Path | Verified state `[2026-08-06 / Wave 2]` |
|---|---|
| DOM `MediaItem` shape | `photo` from `<img>`; `video` or `animated_gif` from `<video poster>` (`dom-post-brief.ts:53-97`). `width` / `height` / `videoVariants` still **never set** on the DOM path |
| Video / GIF alt on the DOM path | Best-effort `aria-label` when not a generic label (`dom-post-brief.ts:82-86`); still weaker than GraphQL `ext_alt_text` |
| Multi-image describe | **Resolved in code** — up to 4 via `selectMediaForDescription` (`media.ts:111-113`); partial-view line when fewer succeed (`:136-148`). Live four-photo proof outstanding `[F22]` |
| Photo / media vision failure | **Resolved in code** — empty description with visual media → `MEDIA_UNREADABLE`; compose always emits `<untrusted_post_image>` when media exists (`prompts.ts:176-188`) |
| Video / GIF with no readable poster | Fallback strings via `fallbackDescriptionForMedia` (`media.ts:128-134`) |
| Groq asymmetry | Multi-image + unavailability path shared; vision/comprehend token budgets and poster-frame vision parity gaps from `[D7]` may still differ — re-check `groq.ts` before claiming full parity |
| Video frame extraction | Does not exist anywhere. `pickLowestBitrateVariant` still has zero call sites `[F21]`; 3-keyframe path remains deferred |
| Long-form post text | The DOM path reads only `[data-testid="tweetText"]`. No `note_tweet` handling, no "Show more" expansion. The GraphQL path handles it correctly — wired after Wave 1 / `[F1]`, live `note_tweet` capture still unobserved |
| Live GraphQL `video_info` on GIFs | **UNVERIFIED** — code consumes variants when present; whether X always sends them is unknown |

### 7.4 Rules

- Media that exists but cannot be described must be **declared** to the model, never silently omitted.
  Wave 2 closed the silent-omit hole (`MEDIA_UNREADABLE` / compose fence). Keep that invariant when
  adding media kinds.
- `ext_alt_text` first, always. It is free, human-written, and saves a VLM call `[plan §3]`.
- Image descriptions stay fenced as untrusted in both stages (`prompts.ts:38`, `:88-90`) — I7.
- Provider parity is required for anything this section calls "must work." A capability that exists only
  on Gemini must either be added to Groq or Groq must be documented as an escape hatch (§11 Q4).

---

## 8. Definition of done

A change is done when **all** of the following hold. Not four of five.

1. **`npm run build` succeeds.** Build runs `npm run typecheck && wxt build`. The
   `build:manifestGenerated` hook fails the build if the MAIN-world interceptor entry, its bundle path,
   or the absence of `web_accessible_resources` regresses.
2. **Zero first-party `tsc` errors.** Baseline `[verified 2026-08-06 / Wave 3 via npm run typecheck]`:
   **0**. Cleared in Wave 3 (was 3: `content.ts` TS2769, `composer.ts` TS6133, `dom-post-brief.ts`
   TS7022; earlier 14 including the deleted `src/` tree). `"typecheck": "tsc --noEmit"` is chained into
   `build`. There is still no `lint` script and no ESLint/Biome config — ESLint was skipped during item
   14 because introducing it would have downgraded WXT/Vite via a then-existing version mismatch.
   `tsconfig` still sets `strict`, `noUnusedLocals`, and `noUnusedParameters`. `\r\r\n` line endings in
   two files remain a hygiene issue under `[F14]` but no longer produce `tsc` errors.
3. **The observable from §3.4 (d) was actually observed.** State what you ran and what you saw. If the
   observable requires a logged-in x.com session and you cannot produce one, say so explicitly and mark
   the change unverified — do not describe it as done. "Implemented, awaiting live verification" is the
   honest status for much of Wave 1.
4. **The guideline item from §3.1 (a) is satisfied**, and if the change only partially satisfies it, say
   which part remains.
5. **No invariant in §2 is weakened.** If one is, the change requires explicit user sign-off first.
6. **If the change fixes a finding, `docs/ARCHITECTURE.md` is updated** to record that the finding is
   resolved and by what — accurately, not optimistically. That file is the current-state authority;
   leaving it stale recreates the status-marker problem `[R3]`. Unverified observables stay marked
   unverified.

---

## 9. The prioritized remediation backlog

This is the execution plan. It is ordered by user-visible impact and dependency, **not** by finding
number. Sizes are XS (under an hour), S (a few hours), M (a day or more).

Read this ordering as binding. If you want to work out of order, justify it against §3.5.

**Wave tracker `[reconciled 2026-08-06 / Wave 3]`:**

| Wave | Items | Status |
|---|---|---|
| Wave 1 | 1, 2, 3, 4, 5, 8, 10 | Code landed. Several observables still **"implemented, awaiting live verification"** (no x.com session / API key in the reconciliation pass). |
| Wave 2 | 6, 7, 9 | **Code landed.** Observables **"implemented, awaiting live verification"** (harness / static proof where noted; live x.com + API key still needed for word-count, media-kind, and latency trials). |
| Wave 3 | 11, 12, 13, 15 (correctness slice) | **Code landed.** Live x.com observables still **"implemented, awaiting live verification"** (listed on items 11–13 / 15). Q2 unanswered; F23 tests deferred. |
| Hygiene | 14 | **Done (partial scope)** — `src/` deleted; `typecheck` added and chained into `build`; lint skipped; baseline **0** after Wave 3. `\r\r\n` / `.gitattributes` still open under `[F14]`. |

Each item below carries a **Status** line. Update it when the status changes; do not invent parallel
trackers.

### 1. Instrument execution and latency — XS, no dependencies

- **Status:** Implemented, awaiting live verification (Wave 1).
- **Grounded in:** `[plan todo:prefetch]` *"Measure end-to-end perceived latency against the 700-1200ms
  motor-time window"*; `[F17]`; `[user]` *"generation took 6-7 seconds"*.
- **Was broken:** nothing measured; `performance.now(` had zero occurrences.
- **Landed:** `lib/perf.ts` — `logEntry` in every entrypoint, Stage 1/2 and click-to-card marks, persisted
  as `chrome.storage.local.xrcLastPipelineTiming`. Finding `[F17]` stays open until real warm/cold
  numbers exist (budgets landed under item 9).
- **Observable (still outstanding):** with a post open and Reply clicked on live x.com with an API key,
  the console shows entry-point lines and a timing breakdown; `chrome.storage.local.get('xrcLastPipelineTiming')`
  returns the last run.
- **Why first:** it is the observable that items 2, 4, 8, and 9 are verified against, and it makes R1
  cheap forever.

### 2. Register the MAIN-world interceptor at `document_start`, with allowlist-before-parse in the same change — S

- **Status:** Implemented; manifest statically verified; live x.com awaiting verification (Wave 1).
- **Grounded in:** `[F1]`, `[F7]`, `[plan todo:scaffold]` *"MAIN-world interceptor entrypoint at
  document_start"*, `[plan §1]` *"A `document_start` MAIN-world script that proxies `window.fetch`…"*,
  `[plan §5]` *"That allowlist is the auditable privacy story."*
- **Was broken:** `interceptor.main.ts` used `defineUnlistedScript`; never injected; allowlist ran after
  full JSON parse.
- **Landed:** `entrypoints/interceptor.content.ts` via
  `defineContentScript({ world: 'MAIN', runAt: 'document_start', … })`. Generated manifest
  `[verified 2026-08-06]`: second `content_scripts` entry with `"world":"MAIN"`,
  `"run_at":"document_start"`, `content-scripts/interceptor.js`; permissions still only `storage` +
  `clipboardWrite`; no `web_accessible_resources`. Allowlist-before-parse + unified allowlists (`[F20]`);
  harvest names narrowed (dropped regex matches for `ProfileTweets` / `UserWithProfile` /
  `ProfileModules`); P4 structural `userId` / `focalTweetId` fallbacks retained. Bound-fetch
  `nativeToString` captured from unbound `window.fetch`. `build:manifestGenerated` hook fails on
  regression.
- **Observable:** manifest entry — **observed** this reconciliation. Still outstanding on live x.com:
  interceptor `[XRC Entry]` in the **page** console; `Function.prototype.toString.call(fetch)` native;
  `TweetDetail` hit vs DM drop with no parse.
- **Depends on:** item 1 for the execution proof. **Blocks:** 4, 5, 11, 12, 13.
- **Do not merge the two halves separately.** (Historical note: they shipped together in Wave 1, as
  required.)

### 3. Unify the IndexedDB schema — XS, no dependencies

- **Status:** Done (Wave 1). Wave 1 recorded verification against a real IndexedDB implementation in
  three upgrade scenarios; this reconciliation pass confirmed the code shape only
  (`lib/corpus.ts` owns `openDb`, `DB_VERSION = 2`; `lib/flywheel.ts` imports it).
- **Grounded in:** `[F5]`.
- **Was broken:** two `openDb` declarations at version 1; flywheel could create a poisoned DB with only
  `posted_diffs`.
- **Landed:** single schema owner; idempotent upgrade creates missing stores and indexes.
- **Observable:** on a fresh profile, flywheel-first then corpus succeeds; `indexedDB` shows all three
  stores. (Wave 1 claimed this observed; not re-run here.)
- **Why this early despite low user visibility:** it is XS, the failure is irrecoverable without deleting
  site data, and items 12 and 13 are not trustworthy until the schema has one owner.

### 4. Prefetch on post open — S

- **Status:** Implemented, awaiting live verification (Wave 1).
- **Grounded in:** `[plan todo:prefetch]` *"Split into Comprehend (multimodal, on post-open,
  session-cached by tweet ID) and Compose (text-only, on reply click)"*; `[user]` *"the comments only
  started generating when i clicked on reply"*; `[user]` *"i was promised that by the time i clicked on
  reply the comments will already be generated"*.
- **Was broken:** earliest capture was reply-click; Stage 1+2 ran serially after the click because the
  interceptor was dead.
- **Landed:** GraphQL `TweetDetail` / post-open path calls `prefetchComprehend` → `COMPREHEND`; session
  cache by tweet ID. Code present in `entrypoints/content.ts` / `background.ts`.
- **Observable (outstanding):** open a post without clicking Reply; item-1 timing shows completed
  comprehend / `postOpenToComprehendMs`; then click Reply and click-to-card is under the §5.4 warm budget.
- **Depends on:** 1, 2.

### 5. The top-replies avoidance signal must reach generation — S

- **Status:** Implemented, awaiting live verification (Wave 1). `[F9]` half-closed (fence + delimiter
  neutralization); author-handle validation remains item 15.
- **Grounded in:** `[plan §3]`, verbatim: *"Reading the top 10 replies matters for **avoidance**, not
  imitation…"* Plus `[user]`: *"i dont think it was reading the top 10 or 20 replies"*.
- **Was broken:** DOM path hardcoded `topReplies: []`; GraphQL extractor never ran; `repliesAlreadySaid`
  unfenced.
- **Landed:** GraphQL path can supply up to 10; DOM fallback scrapes visible reply articles
  (`lib/dom-post-brief.ts`); `repliesAlreadySaid` wrapped in `fenceUntrusted('replies_already_said', …)`;
  fence delimiters inside content neutralized.
- **Note on the count:** the plan specifies **10**. "Top 20" in `[plan §1]` is API cost math, not a
  product requirement.
- **Observable (outstanding):** debug record for a post with replies shows non-empty `topReplies` and
  non-empty `repliesAlreadySaid`; compose prompt contains the fenced bulleted list rather than
  `- (none listed)`.
- **Depends on:** 2.

### 6. Refinement chips must produce the requested direction — S, no dependencies

- **Status:** Implemented, awaiting live verification (Wave 2). Effect threading harness-verified;
  live before/after word-count comparison still needs the user.
- **Grounded in:** `[user]`, verbatim: *"you gave 5 options to enhance the comment like funnier, sharper,
  shorter etc, but shorter gave even longer comments on re-generation"*. Plus `[plan §6]`: *"Refinement is
  one-tap modifiers, not a chat box — shorter, sharper, funnier, less agreeable, add a question."*
- **Was broken `[2026-08-06]`:** five signals fought `shorter` — qualitative-only chip line; StyleCard
  median Target appearing earlier; exemplars pinned to median; rerank `lengthPenalty` rewarding median;
  gate bounds ignoring the chip. Also a blind regeneration (prior draft not passed back).
- **Landed `[verified 2026-08-06]`:** `resolveRefinementEffect` (`lib/prompts.ts:32-101`) produces a
  machine-readable effect. For `shorter`, adjusted `targetWordCount` / P25 / P75 thread into:
  1. Prompt — REFINEMENT instruction **first**, then Target from `styleCardForRefinement`
     (`prompts.ts:192-208`);
  2. Exemplars — `getExemplarsForCompose(effect.targetWordCount)` (`background.ts:319-321`);
  3. Gate bounds — `GateContext.refinement` + tighter slack for `shorter` (`rerank.ts:75-132`,
     `background.ts:101-127`);
  4. Rerank length target + chip soft bonuses (`rerank.ts:171-190`).
  Design choice stated in code: prior draft is intentionally not passed back — directed regeneration,
  not an edit (`prompts.ts:16-17`).
- **Observable (outstanding):** on the same post, mean word count of the three rendered suggestions
  before vs after `shorter` must be lower. That live comparison is the whole product test.
- **No dependencies.**

### 7. Multimodal proven for image, video, and GIF — M

- **Status:** Implemented, awaiting live verification (Wave 2). Live proof per media kind still needs
  the user. Whether live GraphQL always includes `video_info` on GIFs is **UNVERIFIED**.
- **Grounded in:** `[plan todo:media]` (quoted in §7), `[user]` *"i dont even know if our product handles
  images, videos, gifs well and understands them??"*, `[F22]`.
- **Was broken:** GIFs treated as still images (GraphQL) / untyped videos (DOM); only the first of up to
  four images described; failed vision silently omitted the compose image block; DOM never captured
  video alt; Groq poster-frame gaps (`[D7]`).
- **Landed `[verified 2026-08-06]`:** GIF video-family path (`media.ts:53-88`, `79-88`); DOM
  `tweet_video_thumb` → `animated_gif` (`dom-post-brief.ts:80-91`); multi-image up to 4
  (`MAX_DESCRIBE_MEDIA`, `selectMediaForDescription`); `imageDescription` reaches compose in
  `<untrusted_post_image>` (`prompts.ts:176-188`); explicit unavailability via `MEDIA_UNREADABLE`
  (`media.ts:103-105`). 3-keyframe canvas path still deferred. See §7.1–§7.3.
- **Observable (outstanding):** one real post per media kind — single photo with alt, single photo
  without alt, four-photo post, native video, animated GIF — debug record + compose prompt show a
  description or explicit unavailability.
- **Depends on:** 2 for live rich-path proof (alt text, variants, dimensions).

### 8. Eliminate hot-path waste — S, no dependencies

- **Status:** Implemented, awaiting live verification (Wave 1).
- **Grounded in:** `[F6]`, `[F7]`, `[user]` *"there would also be many unintended, dead loops, unnecessary
  checks that slow down the process so appropriately handle and eliminate them"*.
- **Was broken:** document-wide unthrottled `MutationObserver` + script-tag scan on every mutation and a
  5s interval; unthrottled scroll reposition; per-reply harvest messages.
- **Landed:** observer scoped to `header[role="banner"]` (fallback `nav` / `body`), debounced 250 ms,
  disconnected once handle and user id are known; script sweep capped; Escape-dismiss re-open removed;
  `positionCard` rAF-throttled; harvest batched. `[F7]` allowlist-before-parse shipped with item 2.
- **Observable (outstanding):** a Performance profile while scrolling the timeline shows no repeated
  script-tag scan; handle-detection is called a bounded number of times per page load.

### 9. Bring latency inside the budget — M

- **Status:** Extended 2026-08-07 (model pin + 3.x minimal thinking + compose-prefix
  `createCachedContent` + usage ledger). Prior Wave 2 caps remain. Live warm/cold trials still
  **outstanding** — `[F17]` open until recorded. Sub-5s cold is a **hypothesis** until
  `xrcLastPipelineTiming` shows it.
- **Grounded in:** `[plan §1]` (the 700-1200 ms window), `[F17]`, `[user]` *"generation took 6-7
  seconds"*; `[user]` model switch / min thinking / `createCachedContent` / cost dashboard.
- **Was broken:** unbounded config-rejection fallback (16384), cold ListModels every wake, messaging
  retry fan-out to minutes, no wall-clock abandon across model fallbacks (see §5.3 historical rows);
  silent cascade to `gemini-2.5-flash` when lite was unavailable; 3.x thinking uncontrolled on
  generateContent.
- **Landed `[verified 2026-08-06]`:**
  - Config-rejection ceiling **5120** (compose fallback **4608** = 4096+512), logged on both routes
    (`gemini.ts`);
  - ListModels persistence with `discoveredGeminiModelsAt` + 24 h TTL;
  - Messaging: COMPOSE/COMPREHEND timeout **12 s**; non-transient errors break immediately;
  - Wall-clock abandon further model fallbacks after **8 s** (`COMPOSE_WALL_CLOCK_MS`);
  - StyleCard + gate load start before compose; gate await deferred after generation;
  - `persistGeminiPrefs` writes only on change;
  - Happy-path 2.5 thinkingBudget:0 preserved (§4 R4).
- **Landed `[verified 2026-08-07]` (code):**
  - `UserSettings.geminiModel` default `gemini-2.5-flash-lite`; Options picker; pin-only
    `resolveModelOrder` (no silent Flash cascade);
  - Preference list includes `3.1-flash-lite` / `3.5-flash-lite`;
  - 3.x `thinkingConfig.thinkingLevel: 'minimal'` on generateContent; Interactions still
    `thinking_level: minimal`;
  - Compose prefix/suffix split + `lib/gemini-cache.ts` `createCachedContent` (graceful skip under
    min tokens);
  - `lib/usage.ts` lifetime ledger + Options dashboard + card spend chip.
- **Observable (outstanding):** item-1 timing log shows warm compose under 1200 ms and cold under
  5000 ms (user target) / 4000 ms (§5.4) across ten trials, recorded in `docs/VERIFY.md`. Cache hit
  shows `cachedContentTokenCount` or an explicit under-min skip log.
- **Depends on:** 1, 4. **Do not** loosen 2.5 happy-path thinkingBudget:0 — §4 R4.

### 10. Make `chrome.storage.session` reachable — XS, no dependencies

- **Status:** Implemented, awaiting live verification (Wave 1).
- **Grounded in:** `[F3]`.
- **Was broken:** content script could not write `chrome.storage.session`; promise was `void`-ed.
- **Landed:** service worker calls
  `chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })` (guarded for
  the Node build shim); `setLastServedSuggestion` and related writes log on rejection.
- **Observable (outstanding):** after clicking a suggestion on live x.com,
  `chrome.storage.session` contains `served:<tweetId>` with the expected text and index.
- **Blocks:** 12.

### 11. Make the governor actually count — S

- **Status:** Implemented, awaiting live verification (Wave 3).
- **Grounded in:** `[F2]`, `[plan todo:governor]` *"Rate governor with a hard visible budget,
  shape-variance enforcement, and per-target-account nudges"*, and `[plan §5]`: *"There is a documented
  case of a fully manual human workflow getting shadowbanned on volume and repetition alone."*
- **Was broken:** `recordReplyToAccount` only ran from unsent `RECORD_POST`; `CREATE_TWEET` did not
  count; handler keyed by tweet ID; `checkShapeVariance` unused; `GET_GOVERNOR_STATUS` never sent.
- **Landed `[verified 2026-08-06 / Wave 3 code]`:** `handleCreateTweet` calls
  `recordReplyToAccount(sanitizeAuthorHandle(...))` (`background.ts:308-324`); `enrichGovernorStatus`
  wires `checkShapeVariance` over recent `posted_diffs` (`:192-201`); card + Options send
  `GET_GOVERNOR_STATUS` and render remaining budget (`content.ts:750-756`, `App.tsx:164-166`, `:877-881`).
- **Observable (outstanding — live x.com):** CreateTweet → governor increments; card budget updates after
  posts.
- **Depends on:** 2 if counting on `CreateTweet` (taken).

### 12. Make the flywheel learn — M

- **Status:** Implemented, awaiting live verification (Wave 3). Prerequisites 2, 3, 10 are in code; live
  session round-trip for served suggestions (item 10) still unobserved.
- **Grounded in:** `[F4]`, `[plan todo:flywheel]` *"Capture CreateTweet ground truth, diff against the
  served suggestion, store the pairs, and regenerate the StyleCard every ~50 posted replies with a visible
  before/after"*, `[plan §6]` *"the diff between the suggestion and what you posted (strong)"*.
- **Was broken:** no edit distance stored; posted text never entered `replies`; regeneration re-derived
  an identical harvest-only StyleCard; no before/after UI.
- **Landed `[verified 2026-08-06 / Wave 3 code]`:** `recordCreateTweet` stores edit distance + normalized
  distance, inserts `postedText` via `harvestReply`, then `maybeRegenerateStyleCard`
  (`flywheel.ts:132-158`); Options surfaces `xrcLastStyleRegen` before/after (`App.tsx:176-184`,
  `:921-941`); `getAllDiffs` feeds shape variance (item 11).
- **Observable (outstanding — live x.com):** CreateTweet → flywheel row with real served suggestion;
  Options before/after after ~50 real posts.
- **Depends on:** 2, 3, 10.

### 13. Make harvesting work — and keep it opt-in, default off — M

- **Status:** Implemented, awaiting live verification (Wave 3). Interceptor registration (item 2) removes
  the historical registration stop; `harvestEnabled` remains default-off by design (`storage.ts:11`).
- **Grounded in:** two user statements that must be read together.

  `[user]`, at the time it was disabled: *"i think doing comment harvesting is ruining the comment quality,
  and it is now commenting irrelevant things from the post. reset the harvest corpus to 0."*

  `[user]`, now: *"the comment harvesting never ever worked"*

  Plus `[plan todo:corpus]` and `[plan §6]`, which made harvesting the onboarding trust moment: *"Open your
  profile, click Replies, hold End for 60 seconds… Seeing an accurate mirror of yourself is what earns the
  install."*

- **The decision this document makes, and its ground.** Fixing harvesting means **making it work while
  leaving it opt-in and default-off**. The user's disabling instruction was explicit and specific ("reset
  the harvest corpus to 0"), so re-enabling it by default would override a stated preference. But the
  attribution of poor quality to harvesting is unproven — `docs/ARCHITECTURE.md` D6 says so plainly:
  *"off-topic replies were more plausibly caused by the empty `topReplies` avoidance signal, or by
  exemplars selected purely on length with no topical grounding, than by the corpus itself."* Both
  alternatives are backlog items 5 and 6. So: repair the mechanism, keep `harvestEnabled: false`
  (`storage.ts:11`) as the default, keep the existing Options toggle, and let the user re-test once 5 and
  6 have landed. **Do not change the default without an explicit user instruction.**
- **Landed:** handler still gates on `settings.harvestEnabled` (correct); interceptor stop removed in
  Wave 1; Wave 3 confirms the opt-in path is wired end-to-end in code (batch harvest + toast + corpus).
- **Observable (outstanding — live x.com):** Harvest on Replies tab with toggle on + `xrc_debug_harvest=1`.
- **Depends on:** 2, 3.

### 14. Delete the dead `src/` tree; add `typecheck` and `lint` — S, no dependencies

- **Status:** Done (partial scope) `[verified 2026-08-06 / Wave 3]`.
- **Grounded in:** `[F15]`, `[F14]`.
- **Was broken:** `src/` had 18 abandoned files contributing 9 of 14 `tsc` errors; no `typecheck` /
  `lint` scripts.
- **Landed:**
  - `src/` deleted (0 matches under `src/**`).
  - `"typecheck": "tsc --noEmit"` in `package.json`; chained into `build` as
    `"build": "npm run typecheck && wxt build"` once the baseline hit zero (Wave 3 docs/hygiene pass).
  - **ESLint / `lint` script skipped** — would have downgraded WXT/Vite via a then-existing version
    mismatch. Still no ESLint or Biome config.
  - First-party baseline **0** after Wave 3 (was 3). `.gitattributes` / `\r\r\n` normalization remain
    open under `[F14]`.
  - Dependency fix recorded with this hygiene pass: `package.json` `"wxt"` is `^0.20.27`; lockfile root
    entry may still say `^0.20.7` until the next `npm install` (installed package is 0.20.27).
- **Observable:** `npm run typecheck` exits 0; `npm run build` runs typecheck then wxt; `Glob src/**`
  is empty.
- **Note:** deleting `src/` is pre-approved under §3.5 as provably dead code. Deleting anything else is
  not.

### 15. The correctness band — S each, no dependencies unless noted

- **Status:** Correctness slice **implemented, awaiting live verification** (Wave 3) for F8, F9 handle,
  F10, F11, F12, F13, F18. Multi-image (F22) landed under item 7 (Wave 2). **Still open:** Q2 / F16
  trust-boundary policy (user unanswered), VERIFY.md name mismatches (F19), and F23 tests (deferred).
  Do not mark the whole band fully verified.

Group these; each is small, each is grounded, none is user-visible on its own.

| Item | Grounded in | Broken | Fixed / observable |
|---|---|---|---|
| Fence `repliesAlreadySaid`; validate the author handle | `[F9]`, `[plan §5]` | Was: `repliesAlreadySaid` unfenced; handle unfenced from permissive DOM regex | **Done in code (Wave 1 + Wave 3):** fence + delimiter neutralization; `sanitizeAuthorHandle` `/^[A-Za-z0-9_]{1,15}$/`. Observable outstanding: prompt dump |
| Verify insert by the Post button, not text equality | `[F11]`, `[plan §5]` | Was text-equality only | **Done in code (Wave 3):** `insertLooksSuccessful` = `composerMatches && isPostButtonEnabled` (`composer.ts:95-97`). **Observable (outstanding):** F11 — insert enables Post on real Lexical composer |
| Reconcile `emojiRate` units | `[F12]`, `[plan §4]` | Per-reply vs per-word mismatch; inert gate | **Done in code (Wave 3):** per-reply unit in derive / prompt / gate (`style-card.ts:85`, `prompts.ts:210`, `rerank.ts:134-137`) |
| Fix banned-pattern matching | `[F13]` | Literal placeholders + `includes()` | **Done in code (Wave 3):** regex sources in `DEFAULT_STYLE_CARD.bannedPatterns`; `RegExp` test in gate; prompt describes patterns in words (`prompts.ts:608-612`, `:213`, `rerank.ts:144-154`) |
| Nonce the `postMessage` channel | `[F8]` | Prefix match, no nonce | **Done in code (Wave 3):** shared nonce, exact `source === CHANNEL`. **Observable (outstanding):** forged `postMessage` from page console ignored |
| Do not cache a degraded comprehend | `[F10]` | Fallback cached for session | **Done in code (Wave 3):** `degraded` flag; skip session cache; card surfaces it (`gemini.ts` / `groq.ts` / `background.ts:170-171`, `content.ts:536-537`) |
| Describe more than the first image | `[F22]` | Was `.find()` first-only | **Landed under item 7 (Wave 2)**. Observable outstanding: live four-image post proof |
| Reconcile the README trust boundary | `[F16]`, `[F19]`, I4 | Options-page validation vs SW-only docs | README describes Options-page validation and flags Q2. **Q2 still unanswered.** VERIFY.md name mismatches still open. **See §11 Q2** |
| Demote lifecycle logging | `[F18]` | Lifecycle at `console.error` | **Done in code (Wave 3):** `console.debug` for module load / SW start (`background.ts:39`, `:476`) |
| Add tests for the pure functions | `[F23]` | No test framework / CI | **Deferred.** Vitest over parser/gate/pure helpers still outstanding. Observable: `npm test` green in CI |

---

## 10. Out of scope

Each exclusion is dated and carries its rationale so it is not silently reopened. Anything here may be
revisited, but only by an explicit user decision recorded as an amendment to this document.

### OOS-1. `AnnaWegmann/Style-Embedding` reranker — excluded 2026-08-06

`[plan todo:rerank]` asked for it, verbatim: *"Local Stage 3: Wegmann style-embedding reranker against a
cached author centroid, calibrated on held-out own-replies, ensembled with character n-gram distance."*
And `[plan §4]`: *"**Local rerank** with `AnnaWegmann/Style-Embedding` (~125M, conversation-controlled
contrastive training, closest available match to X replies) against a precomputed author centroid.
Calibrate against the distribution of your own held-out replies rather than an absolute threshold, since
none of these models is validated at 40-word length."*

It was never built `[D9]`, and `[verified 2026-08-06]` no reference to it exists anywhere in the shipping
source — only `docs/ARCHITECTURE.md` and an untracked scratch file mention the name. The reasons for
excluding it, as presented to the user:

- It is a ~400-500 MB PyTorch model. Running it in-browser needs ONNX conversion plus quantization, and
  even then adds tens of megabytes and a cold-start cost to an extension whose entire current build output
  is **292.9 KB** `[verified 2026-08-06, .output/chrome-mv3 total]` — of which `interceptor.js` is 10.9 kB
  of never-executed code.
- It was trained on Reddit conversations, not 40-word tweets. The plan itself concedes the validity gap:
  *"none of these models is validated at 40-word length"* — which is precisely why it also demanded a
  calibration harness that was never built.
- It is useless with an empty corpus. Harvesting stays opt-in default-off (`storage.ts:11`) and live
  Replies-tab harvest is still unproven, so there is no author centroid worth embedding against.

**Recommendation given and accepted: skip it.** Revisit only if a real corpus exists *and* drafts still do
not sound like the user. Until then, `rerank.ts`'s character-trigram cosine plus the deterministic gate
is the whole of Stage 3, and the documentation must say so rather than implying the plan's ensemble
shipped.

### OOS-2. The 3-keyframe blob-URL video canvas path — deferred by the plan itself

`[plan todo:media]`: *"Defer the 3-keyframe blob-URL canvas path until measured as necessary."* Correctly
deferred `[D-media row in ARCHITECTURE §8]`. Poster-frame description is the contract (§7.2). Reopen only
with a measurement showing poster frames are insufficient.

### OOS-3. Fine-tuning / LoRA per user — Phase 5

`[plan §7]`: *"Phase 5 (optional): LoRA fine-tune per user; desktop companion for non-browser surfaces."*
`[plan §4]` notes the upside is real (*"drops human detection of AI tweets from 61.2% to 53.9%"*) but it
requires *"800-2,000 of your own posts"*, and the flywheel that would accumulate them is now wired in
code (Wave 3 / item 12) but still awaiting live CreateTweet verification. Not reachable until that
path is proven on a real session.

### OOS-4. The desktop/ambient companion — Approach B, explicitly a later second surface

`[plan §2]`: *"Verdict: a good *second surface* later, a bad primary."*

### OOS-5. Server-side agent on the official X API — permanently rejected

`[plan §2]`, Approach C: *"Verdict: **rejected.** Documented so the decision is recorded."* See I2.

### OOS-6. Telemetry spoofing / detection evasion — rejected on evidence

`[plan §1]`: *"Compete on content quality, not telemetry spoofing."* `[plan §4]` also rules out raising
temperature to evade detection and injecting typos as generic humanization: *"a deliberately misplaced
typo is exactly the artifact a trained classifier learns."*

### OOS-7. Topical exemplar retrieval — rejected on evidence

`[plan §4]`: *"**Retrieve topically-similar exemplars.** Cut authorship-attribution accuracy roughly in
half in a 400-author study. This is counterintuitive and I nearly recommended it."* Exemplar selection
stays length-matched (`corpus.ts:141-147`). If topical grounding is wanted, it belongs in the comprehend
signal or `topReplies` — item 5 — not in exemplar selection.

### OOS-8. hiQ v. LinkedIn as a legal argument — forbidden in any document

`[plan §5]`: *"**Do not put hiQ v. LinkedIn in any doc as load-bearing.** It covers unauthenticated public
data; we read a logged-in session."*

### OOS-9. The free Google AI Studio tier — disqualified

`[plan §5]`: *"Disqualify the free Google AI Studio tier outright — it trains on your data and permits
human review."* Onboarding copy must not steer users to it.

---

## 11. Open questions requiring user input

Kept deliberately short. These are the ones that actually block or misdirect work; everything else has a
defensible default already recorded above.

**Q1. Should the trigger for prefetch be post-open only, or also timeline hover/dwell?**
`[plan todo:prefetch]` says *"on post-open"*, and `HomeTimeline` is already in the compose allowlist
(`graphql-parser.ts:3`), which means a timeline scroll could plausibly prefetch for many posts at once.
That would multiply API spend. Blocks item 4's design: post-open only is the literal reading of the plan
and the safe default, but the allowlist suggests broader intent. **Default if unanswered:** post-open
only.

**Q2. Should API-key validation move back behind the service worker, or should the README be corrected?**
This is the one live invariant tension (I4, `[F16]`, `[D8]`). Moving it back restores the plan's
guarantee and is now feasible because `lib/messaging.ts` has a working wake-and-retry; correcting the
README is honest and cheaper. **Still unanswered by the user.** Docs reconciliation (2026-08-06) updated
`README.md` to describe Options-page validation as the current behaviour and left this question flagged.
**Recommendation on the table (not a decision):** keep Options-page validation — it is what makes key
setup work under the MV3 service-worker lifecycle; the key never leaves `chrome.storage.local` either
way and never reaches a content script or the page. Blocks a final I4 / item-15 settlement until the
user chooses.

**Q3. Is Groq a first-class provider or an escape hatch?**
The two have already drifted `[D7]`: Groq's comprehend has a 300-token budget vs Gemini's 2048, a
100-token vision budget vs 512, no poster-frame vision at all, and no parse-failure logging. Parity is
real work. Blocks item 7's scope. **Default if unanswered:** escape hatch, and Options says so.

**Q4. Does the disclosure need an affirmative acceptance gate before onboarding proceeds?**
`README.md:36` promises one; the code has static text instead `[F19]`. `[plan §5]` requires the feature be
*"prominently described both on the store listing *and in the extension UI*"* — which static text arguably
satisfies. This is a store-submission judgement, not a code question. Blocks nothing today; it blocks
store submission. **Default if unanswered:** keep static text, correct the README.

---

## Appendix A. Where `docs/ARCHITECTURE.md`, the plan, and the code disagree

Recorded so the next reader does not have to rediscover these. In each case the resolution is stated.

| Subject | `docs/ARCHITECTURE.md` / prior docs said | Verified 2026-08-06 (docs reconciliation) | Resolution |
|---|---|---|---|
| `tsc` error count | Was 5 first-party + 9 in `src/` = 14; then baseline 3 after Wave 2 | **`npm run typecheck` → 0** after Wave 3. `typecheck` chained into `build`. | Baseline is **0**. Re-run before changing the number. |
| `src/` tree | "17 files" / "18 files", pollutes typecheck `[F15]` | **Deleted** — `Glob src/**` empty | `[F15]` resolved. Historical counts are archival only. |
| Model actually in use | `[D2]`: *"the actual model in use is `gemini-2.5-flash`"* | Code default is `gemini-2.5-flash-lite` (`gemini.ts:761`, `GEMINI_MODELS[0]` at `:17-23`) | Both true at different layers. The code *prefers* flash-lite; the user's key reportedly did not expose it via ListModels, so flash is what ran. Environment-dependent, and unverifiable from the repository. Do not hardcode either. Note `generateContentThinkingConfig` matches `/gemini-2\.5/`, so it covers both. |
| Top-replies count | Reports the code's limit of 10 | Confirmed 10 (`post-brief.ts:15`, `:88`, `:126`) | The plan requires **10** (`[plan §3]`). "Top 20" in `[plan §1]` is part of the API cost calculation, not a requirement. The user's *"top 10 or 20"* is satisfied by 10. |
| Thinking control | §7.3 documents it as implemented | Confirmed implemented and minimal on the happy path; Wave 2 capped config-rejection at 5120 (`gemini.ts:488-493`) | Happy-path thinking stays untouched (§4 R4). Unbounded 16384 fallback is closed in code (item 9); latency measurement remains open (`[F17]`). |
| GIF handling | `[plan todo:media]` verdict: *"Implemented exactly as planned"* | Was still-image / DOM never `animated_gif`; Wave 2 routes GIF as video-family in both paths (`media.ts:79-88`, `dom-post-brief.ts:80-91`) | Gap the plan did not name; now implemented under §7.1 / item 7. Live GraphQL `video_info` on GIFs still **UNVERIFIED**. |
| `git status` | Snapshot at the start of the review listed several `entrypoints/` and `lib/` files as untracked | `git status --porcelain` shows only `.check.mjs` and `docs/ARCHITECTURE.md` untracked; one commit, `374a288` | Snapshot skew. Nothing load-bearing depends on it. Only the single-commit fact is used in this document. |
| Wegmann reranker | `[D9]` records it as *"silent scope reduction rather than a forced trade"* with no decision on record | Confirmed absent from all shipping source | Now an explicit, dated, reasoned exclusion — OOS-1. `[D9]`'s open question is closed. |
| Harvesting | `[D6]` records it disabled at the user's request, and calls the causal attribution *"unproven"* | Opt-in default-off retained; interceptor stop removed (Wave 1); Wave 3 marks path **implemented, awaiting live verification** | Keep default off. Competing explanations `[D6]` names are backlog items 5 and 6. |

## Appendix B. Amending this document

This document is versioned. Amendments require a user decision, recorded here with a date and the
decision's grounding, in the same style as §10. Do not silently edit an invariant. Do not add a
requirement that has no cited source — if a new requirement is needed and no source exists, get a user
statement first and quote it.
