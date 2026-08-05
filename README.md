# X Reply Copilot

A human-in-the-loop reply co-pilot for X (Twitter). Passively reads X's own GraphQL network traffic (zero extra requests), pre-generates suggestions before you ask, and drafts in your measured voice.

## Features

- **Passive observation** — MAIN-world fetch interceptor at `document_start` reads GraphQL responses as you browse (manifest-registered; live x.com behaviour awaiting verification)
- **Three-stage pipeline** — Comprehend (multimodal) → Compose (verbalized sampling) → Local rerank + output gate
- **Prefetch** — Comprehend on post-open, Compose on reply click (implemented; awaiting live verification)
- **Voice matching** — StyleCard from your harvested replies, 5 exemplars, completion-style prompting
- **Shadow DOM UI** — Suggestion card appears only when composer opens; zero web_accessible_resources
- **Rate governor** — Daily reply budget, per-account nudges, shape variance check (wired on CreateTweet; awaiting live verification — backlog item 11)
- **Flywheel** — Tracks suggestion vs posted diff, feeds posted text into the corpus, regenerates StyleCard every ~50 replies with Options before/after (implemented; awaiting live verification — backlog item 12)

## Install (Load Unpacked)

1. Clone this repo and install dependencies:
   ```bash
   npm install
   npm run build
   ```
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the `.output/chrome-mv3` folder
5. Pin the extension and open **Options** to configure

## API Key Setup

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Use a **paid tier** (free tier trains on your data)
3. Open extension Options → paste key → **Validate** → **Save**
4. Estimated cost: ~$0.50/month for heavy use

## Onboarding

1. **Read the disclosure** — Data-collection text is shown in Options and on the in-page card (there is no separate acceptance gate today)
2. **Add API key** — Validated with a 1-token ping from the Options page
3. **Calibrate voice** — Optional: enable harvesting in Options, open your X profile → Replies tab → scroll. Or import replies manually. Harvesting is **opt-in and default-off**.
4. **Optional conditioning** — Known-for, never-mention, default intent
5. **Use on a post** — View a post (see "Reading this post" indicator) → click Reply → pick a suggestion (⌘1/2/3)

## Development

```bash
npm run dev        # Watch mode with hot reload
npm run build      # typecheck then production build to .output/chrome-mv3
npm run typecheck  # tsc --noEmit (baseline: 0 — see docs/IMPLEMENTATION_GUIDELINES.md §8)
npm run zip        # Package for Chrome Web Store
```

There is no `lint` script yet.

## Architecture

```
MAIN world (document_start)  →  fetch Proxy  →  slim PostBrief via postMessage
ISOLATED content script      →  Shadow DOM card, composer insert
Service worker               →  Gemini API, IndexedDB, StyleCard, governor
Options page                 →  settings UI; API key validation currently runs here
```

## Permissions

| Permission | Why |
|---|---|
| `storage` | API key (local only), StyleCard, governor state |
| `clipboardWrite` | Copy suggestion on card click |
| `x.com/*` | Content scripts + GraphQL interception |
| `pbs.twimg.com/*` | Fetch image bytes for Comprehend |
| `generativelanguage.googleapis.com/*` | Gemini API calls |

## Privacy

- BYO Gemini API key — stored in `chrome.storage.local` only (never sync)
- **Key validation currently runs in the Options page** (not the service worker), so the key is read into Options React state and used for a 1-token provider ping from that context. Generation and other LLM calls still originate from the service worker. The key never reaches a content script or the x.com page realm.
- **Open question (Q2):** whether validation should move back behind the service worker, or whether documenting the Options-page boundary (as above) is the accepted trust model. User asked; unanswered. Recommendation: keep Options-page validation — it is what works under the MV3 service-worker lifecycle; the key never leaves `chrome.storage.local` either way. See `docs/IMPLEMENTATION_GUIDELINES.md` §11 Q2 and finding **F16**.
- Post content sent to Gemini in fenced untrusted-data blocks only
- No data sent to extension author servers
- Visible "Reading this post" indicator while analyzing

## Manual Verification

See [docs/VERIFY.md](docs/VERIFY.md) for empirical checks to run on live x.com.

## License

MIT
