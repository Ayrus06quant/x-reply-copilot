# X Reply Copilot

A human-in-the-loop reply co-pilot for X (Twitter). Passively reads X's own GraphQL network traffic (zero extra requests), pre-generates suggestions before you ask, and drafts in your measured voice.

## Features

- **Passive observation** — MAIN-world fetch interceptor reads GraphQL responses as you browse
- **Three-stage pipeline** — Comprehend (multimodal) → Compose (verbalized sampling) → Local rerank + output gate
- **Prefetch** — Comprehend on post-open, Compose on reply click
- **Voice matching** — StyleCard from your harvested replies, 5 exemplars, completion-style prompting
- **Shadow DOM UI** — Suggestion card appears only when composer opens; zero web_accessible_resources
- **Rate governor** — Daily reply budget, per-account nudges, shape variance check
- **Flywheel** — Tracks suggestion vs posted diff; regenerates StyleCard every 50 replies

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

1. **Accept disclosure** — Required by Chrome Web Store Limited Use policy (August 2026)
2. **Add API key** — Validated with a 1-token ping
3. **Calibrate voice** — Open your X profile → Replies tab → scroll for 60 seconds. Your StyleCard auto-populates from harvested replies.
4. **Optional conditioning** — Known-for, never-mention, default intent
5. **Use on a post** — View a post (see "Reading this post" indicator) → click Reply → pick a suggestion (⌘1/2/3)

## Development

```bash
npm run dev    # Watch mode with hot reload
npm run build  # Production build to .output/chrome-mv3
npm run zip    # Package for Chrome Web Store
```

## Architecture

```
MAIN world (document_start)  →  fetch Proxy  →  slim PostBrief via postMessage
ISOLATED content script      →  Shadow DOM card, composer insert
Service worker               →  Gemini API, IndexedDB, StyleCard, governor
```

## Permissions

| Permission | Why |
|---|---|
| `storage` | API key (local only), StyleCard, governor state |
| `clipboardWrite` | Copy suggestion on card click |
| `x.com/*` | Content scripts + GraphQL interception |
| `pbs.twimg.com/*` | Fetch image bytes for Comprehend |
| `generativelanguage.googleapis.com/*` | Gemini API calls from service worker |

## Privacy

- BYO Gemini API key — stored in `chrome.storage.local` only (never sync)
- All LLM calls originate from the service worker
- Post content sent to Gemini in fenced untrusted-data blocks only
- No data sent to extension author servers
- Visible "Reading this post" indicator while analyzing

## Manual Verification

See [docs/VERIFY.md](docs/VERIFY.md) for empirical checks to run on live x.com.

## License

MIT
