# Gemini API Troubleshooting (AQ / Auth Keys)

If reply generation fails but your key works in Google AI Studio, use these checks.

## Key types

| Prefix | Type | Notes |
|--------|------|-------|
| `AIza` | Standard API key | Uses `generateContent` with `?key=` |
| `AQ.` | Auth key (2026+) | Often requires **Interactions API**; `generateContent` may return 404 |

Get keys from [Google AI Studio → API Keys](https://aistudio.google.com/apikey).

---

## 1. ListModels (should return flash models)

```powershell
$key = "AQ.your-key-here"
Invoke-RestMethod "https://generativelanguage.googleapis.com/v1beta/models?key=$key" |
  Select-Object -ExpandProperty models |
  Where-Object { $_.name -match "flash" } |
  Select-Object name, supportedGenerationMethods
```

Expected: at least one entry like `models/gemini-2.5-flash`.

---

## 2. generateContent (may 404 on AQ keys — that is OK)

**Header auth (try first for AQ keys):**

```powershell
$key = "AQ.your-key-here"
$body = '{"contents":[{"parts":[{"text":"ok"}]}],"generationConfig":{"maxOutputTokens":4}}'
Invoke-RestMethod -Method POST `
  -Uri "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" `
  -Headers @{ "x-goog-api-key" = $key; "Content-Type" = "application/json" } `
  -Body $body
```

**Query auth:**

```powershell
Invoke-RestMethod -Method POST `
  -Uri "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$key" `
  -Headers @{ "Content-Type" = "application/json" } `
  -Body $body
```

If both return **404**, use Interactions (step 3). The extension handles this automatically for `AQ.` keys.

---

## 3. Interactions API (primary path for AQ keys)

```powershell
$key = "AQ.your-key-here"
$body = '{"model":"gemini-2.5-flash","input":"ok","store":false,"generation_config":{"max_output_tokens":4}}'
Invoke-RestMethod -Method POST `
  -Uri "https://generativelanguage.googleapis.com/v1beta/interactions" `
  -Headers @{
    "x-goog-api-key" = $key
    "Content-Type" = "application/json"
    "Api-Revision" = "2026-05-20"
  } `
  -Body $body
```

Expected: JSON with `output_text` or `steps` containing model output.

---

## 4. Extension steps after fixing / updating

1. Open **Options** → paste your key → **Validate** (must show “Key valid ✓”).
2. If validation fails, copy the **exact error message** (not just “no flash model”).
3. Reload the extension: `chrome://extensions` → **Reload** on X Reply Copilot.
4. Open a post on X → click **Reply** → wait for suggestions.

---

## Reading a failed generation

Every compose failure writes a full diagnostic record to the service worker console **and** to
`chrome.storage.local`. To retrieve the last one:

1. `chrome://extensions` → X Reply Copilot → click **service worker**.
2. Paste into that console:

```js
chrome.storage.local.get('xrcLastGenerationDebug', (r) => console.log(r.xrcLastGenerationDebug));
```

The record contains `model`, `route` (`interactions` or `generateContent`), `httpStatus`,
`interactionStatus`, `finishReason`, `safety`, `usage`, `maxOutputTokens`, `parseStrategy`,
and a 2000-character `rawPreview` of what the model actually returned.

| Field | Means |
|-------|-------|
| `interactionStatus: "incomplete"` | Output hit `max_output_tokens` — usually thinking tokens eating the budget |
| `truncated: true` | Same, detected either from status or from JSON that never closes |
| `parseStrategy: "strict-json"` | Clean parse; if the record exists at all it was only a recovery log |
| `parseStrategy: "plain-text"` | Model ignored the JSON contract; suggestions were recovered from prose |
| `rawPreview: ""` | The API returned nothing — check `httpStatus` and `safety` |

## Thinking tokens and `max_output_tokens`

`gemini-2.5-flash` is a hybrid reasoning model with **dynamic thinking on by default**, and its
thinking tokens are drawn from the same `max_output_tokens` budget as the answer. A small budget
(the extension previously used 1024) can be consumed entirely by reasoning, so the reply arrives
truncated mid-JSON or not at all.

The extension now sends `generation_config.thinking_level: "minimal"` on the Interactions route
(`thinkingConfig.thinkingBudget: 0` on `generateContent` for 2.5 models) and budgets 4096 output
tokens for compose. If the API rejects those fields it retries once without them at a 4× budget.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| 401 / UNAUTHENTICATED | Wrong or revoked key | Create new key in AI Studio |
| 404 on generateContent, ListModels OK | AQ key needs Interactions | Extension v0.1+ tries Interactions first for `AQ.` keys |
| 429 | Rate limit | Wait 60s; key is valid |
| Empty model list | Billing / API not enabled | Enable Generative Language API + billing in AI Studio |
| Blocked key in AI Studio | Leaked or dormant unrestricted key | Generate new restricted/auth key |
| "…was cut off before it finished writing" | Thinking tokens exhausted the output budget | Retry; if persistent, check `usage` in the debug record |
| "…replied, but nothing usable could be read out of it" | Response parsed to zero candidates | Read `rawPreview` in the debug record |
| "the style gate rejected all of them" | Drafts generated fine but failed the output gate | Reason tally is in the message; import replies in Options to widen the range |

---

## What the extension stores

After successful validation, these are saved in `chrome.storage.local`:

- `discoveredGeminiModels` — flash models from ListModels
- `preferredGeminiModel` — last working model
- `geminiAuthMode` — last working auth route (`interactions`, `x-goog-api-key`, etc.)

To reset: clear extension site data or re-validate with a fresh key.
