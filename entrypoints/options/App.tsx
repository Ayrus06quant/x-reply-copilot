import { useCallback, useEffect, useState } from 'react';

import type {

  Conditioning,

  Provider,

  StyleCard,

  StyleCardRegenSnapshot,

  UsageSummary,

} from '../../lib/types';

import { SELECTABLE_GEMINI_MODELS } from '../../lib/types';

import {

  formatUsd,

  getUsageSummary,

  PRICING_STAMP,

  resetUsage,

} from '../../lib/usage';

import { invalidateComposeCache } from '../../lib/gemini-cache';

import { clearGeminiModelOrderCache } from '../../lib/gemini';

import { getSettings, saveSettings } from '../../lib/storage';

import { formatStyleCardSummary } from '../../lib/style-card';

import {

  readStyleCardDirect,

  rebuildStyleCardFromCorpus,

  getCorpusCount,

  importManualReplies,

  clearVoiceData,

} from '../../lib/corpus';

import { sendExtensionMessage } from '../../lib/messaging';

import { validateApiKeyForProvider } from '../../lib/api-validation';

import { getLastStyleRegen } from '../../lib/flywheel';







type Step = 'key' | 'calibrate' | 'condition' | 'done';







const PROVIDER_META: Record<

  Provider,

  { label: string; placeholder: string; keyUrl: string; keyHint: string; disclosure: string }

> = {

  gemini: {

    label: 'Google Gemini',

    placeholder: 'AIza... or AQ....',

    keyUrl: 'https://aistudio.google.com/apikey',

    keyHint:

      'Google AI Studio now issues AQ. auth keys for new accounts (legacy keys start with AIza). Use a paid key if you want to avoid free-tier data use. Typical cost ~$0.50/month.',

    disclosure: 'Content is sent to Google Gemini using your API key.',

  },

  groq: {

    label: 'Groq',

    placeholder: 'gsk_...',

    keyUrl: 'https://console.groq.com/keys',

    keyHint: 'Fast inference on GroqCloud. Free tier has rate limits — check console.groq.com for quotas.',

    disclosure: 'Content is sent to Groq using your API key.',

  },

};







export default function App() {

  const [step, setStep] = useState<Step>('key');

  const [apiProvider, setApiProvider] = useState<Provider>('gemini');

  const [apiKey, setApiKey] = useState('');

  const [keyValid, setKeyValid] = useState<boolean | null>(null);

  const [keyMessage, setKeyMessage] = useState<string | null>(null);

  const [keyWarning, setKeyWarning] = useState<string | null>(null);

  const [validating, setValidating] = useState(false);

  const [styleCard, setStyleCard] = useState<StyleCard | null>(null);

  const [refreshingStyleCard, setRefreshingStyleCard] = useState(false);

  const [styleCardError, setStyleCardError] = useState<string | null>(null);

  const [conditioning, setConditioning] = useState<Conditioning>({});

  const [dailyBudget, setDailyBudget] = useState(50);

  const [corpusCount, setCorpusCount] = useState(0);

  const [manualReplies, setManualReplies] = useState('');

  const [manualHandle, setManualHandle] = useState('');

  const [importingManual, setImportingManual] = useState(false);

  const [manualImportMessage, setManualImportMessage] = useState<string | null>(null);

  const [clearingVoice, setClearingVoice] = useState(false);

  const [clearVoiceMessage, setClearVoiceMessage] = useState<string | null>(null);

  const [harvestEnabled, setHarvestEnabled] = useState(false);

  const [remainingBudget, setRemainingBudget] = useState<number | null>(null);

  /** replyCount for today — kept so raising the max updates "remaining of max" immediately. */

  const [repliesUsedToday, setRepliesUsedToday] = useState(0);

  const [styleRegen, setStyleRegen] = useState<StyleCardRegenSnapshot | null>(null);

  const [geminiModel, setGeminiModel] = useState<string>('gemini-3.1-flash-lite');

  const [usage, setUsage] = useState<UsageSummary | null>(null);

  const [resettingUsage, setResettingUsage] = useState(false);







  const providerMeta = PROVIDER_META[apiProvider];







  useEffect(() => {

    void (async () => {

      const settings = await getSettings();

      if (settings.apiProvider) setApiProvider(settings.apiProvider);

      if (settings.apiKey) setApiKey(settings.apiKey);

      setGeminiModel(settings.geminiModel ?? 'gemini-3.1-flash-lite');

      if (settings.conditioning) setConditioning(settings.conditioning);

      setDailyBudget(settings.dailyReplyBudget);

      setHarvestEnabled(settings.harvestEnabled ?? false);

      if (settings.onboardingComplete) setStep('done');

      else if (settings.apiKey) setStep('calibrate');

      try {

        setUsage(await getUsageSummary());

      } catch {

        /* usage dashboard is best-effort */

      }







      try {

        const card = await readStyleCardDirect();

        setStyleCard(card);

        setCorpusCount(card.corpusSize);

      } catch (e) {

        setStyleCardError(

          e instanceof Error ? e.message : 'Could not read voice profile from local storage',

        );

      }

      try {

        const gov = await sendExtensionMessage({ type: 'GET_GOVERNOR_STATUS', targetHandle: '' });

        if (gov.ok && gov.governor) {

          setRemainingBudget(gov.governor.remainingBudget);

          setRepliesUsedToday(

            Math.max(0, settings.dailyReplyBudget - gov.governor.remainingBudget),

          );

        }

      } catch {

        /* governor display is best-effort */

      }

      try {

        const regen = await getLastStyleRegen();

        if (regen) setStyleRegen(regen);

        else {

          const viaSw = await sendExtensionMessage({ type: 'GET_LAST_STYLE_REGEN' });

          if (viaSw.ok && viaSw.styleRegen) setStyleRegen(viaSw.styleRegen);

        }

      } catch {

        /* before/after is optional until the 50th posted reply */

      }

    })();

  }, []);







  const validateKey = useCallback(async () => {

    const trimmedKey = apiKey.trim();

    if (!trimmedKey) {

      setKeyValid(false);

      setKeyMessage(`Enter your ${providerMeta.label} API key first.`);

      return;

    }







    setValidating(true);

    setKeyValid(null);

    setKeyMessage(null);

    setKeyWarning(null);







    try {

      // Validate directly from Options page — works when service worker is inactive (MV3).

      const result = await validateApiKeyForProvider(apiProvider, trimmedKey, geminiModel);







      setKeyValid(result.valid);

      setKeyMessage(result.message);

      setKeyWarning(result.warning ?? null);







      if (result.valid) {

        clearGeminiModelOrderCache();

        await invalidateComposeCache(trimmedKey);

        await saveSettings({

          apiKey: trimmedKey,

          apiProvider,

          geminiModel: apiProvider === 'gemini' ? geminiModel : undefined,

        });

        try {

          setUsage(await getUsageSummary());

        } catch {

          /* ignore */

        }

        setStep('calibrate');

      }

    } catch (e) {

      setKeyValid(false);

      setKeyMessage(e instanceof Error ? e.message : 'Validation failed — check your network');

    } finally {

      setValidating(false);

    }

  }, [apiKey, apiProvider, geminiModel, providerMeta.label]);







  const refreshStyleCard = useCallback(async () => {

    setRefreshingStyleCard(true);

    setStyleCardError(null);







    try {

      const count = await getCorpusCount();

      setCorpusCount(count);

      const card = await rebuildStyleCardFromCorpus();

      await invalidateComposeCache(apiKey);

      setStyleCard(card);

      setCorpusCount(card.corpusSize);







      try {

        await sendExtensionMessage({ type: 'GET_STYLE_CARD' });

      } catch {

        /* Background sync is optional — IndexedDB is source of truth */

      }

    } catch (e) {

      setStyleCardError(

        e instanceof Error ? e.message : 'Could not refresh StyleCard from harvested replies',

      );

    } finally {

      setRefreshingStyleCard(false);

    }

  }, []);







  const importManual = useCallback(async () => {

    const handle = manualHandle.trim() || styleCard?.sampleHandle?.trim();

    if (!handle) {

      setManualImportMessage('Enter your @handle above, or harvest at least one reply first.');

      return;

    }

    if (!manualReplies.trim()) {

      setManualImportMessage('Paste 3–5 of your replies (one per line).');

      return;

    }







    setImportingManual(true);

    setManualImportMessage(null);







    try {

      const added = await importManualReplies(manualReplies, handle);

      const card = await rebuildStyleCardFromCorpus(handle);

      setStyleCard(card);

      setCorpusCount(card.corpusSize);

      setManualImportMessage(

        added > 0

          ? `Added ${added} reply${added === 1 ? '' : 'ies'} to corpus (${card.corpusSize} total).`

          : `No new replies added — duplicates skipped (${card.corpusSize} total).`,

      );

    } catch (e) {

      setManualImportMessage(e instanceof Error ? e.message : 'Import failed');

    } finally {

      setImportingManual(false);

    }

  }, [manualHandle, manualReplies, styleCard?.sampleHandle]);







  const clearVoice = useCallback(async () => {

    const confirmed = window.confirm(

      'Clear all harvested replies and reset your voice profile? This cannot be undone. Your API key and preferences are kept.',

    );

    if (!confirmed) return;

    setClearingVoice(true);

    setClearVoiceMessage(null);

    setStyleCardError(null);

    try {

      const card = await clearVoiceData();

      setStyleCard(card);

      setCorpusCount(0);

      setManualReplies('');

      setManualImportMessage(null);

      setClearVoiceMessage('Voice data cleared. Corpus is empty — paste replies manually to rebuild your voice profile.');

      try {

        await sendExtensionMessage({ type: 'GET_STYLE_CARD' });

      } catch {

        /* Background sync is optional */

      }

    } catch (e) {

      setStyleCardError(e instanceof Error ? e.message : 'Could not clear voice data');

    } finally {

      setClearingVoice(false);

    }

  }, []);







  const refreshRemainingBudget = useCallback(async (budgetMax?: number) => {

    try {

      const gov = await sendExtensionMessage({ type: 'GET_GOVERNOR_STATUS', targetHandle: '' });

      if (gov.ok && gov.governor) {

        setRemainingBudget(gov.governor.remainingBudget);

        const max = budgetMax ?? dailyBudget;

        setRepliesUsedToday(Math.max(0, max - gov.governor.remainingBudget));

      }

    } catch {

      /* governor display is best-effort */

    }

  }, [dailyBudget]);

  const finishOnboarding = useCallback(async () => {

    await invalidateComposeCache(apiKey);

      await saveSettings({

      conditioning,

      dailyReplyBudget: dailyBudget,

      onboardingComplete: true,

    });

    // Governor reads budget from storage — refresh after save or Ready shows stale

    // remaining from the previous max (e.g. "50 of 100" after raising 50→100).

    await refreshRemainingBudget(dailyBudget);

    setStep('done');

  }, [conditioning, dailyBudget, refreshRemainingBudget]);

  const saveDailyBudget = useCallback(async (value: number) => {

    const next = Number.isFinite(value) ? Math.min(200, Math.max(5, Math.round(value))) : 50;

    setDailyBudget(next);

    await saveSettings({ dailyReplyBudget: next });

    await refreshRemainingBudget(next);

  }, [refreshRemainingBudget]);

  const displayedRemaining =

    remainingBudget === null ? null : Math.max(0, dailyBudget - repliesUsedToday);







  const toggleHarvestEnabled = useCallback(async (enabled: boolean) => {

    setHarvestEnabled(enabled);

    await saveSettings({ harvestEnabled: enabled });

  }, []);







  return (

    <div className="options">

      <header>

        <h1>X Reply Copilot</h1>

        <p className="subtitle">Reply drafts in your measured voice — human-in-the-loop, always.</p>

      </header>







      <nav className="steps">

        {(['key', 'calibrate', 'condition', 'done'] as Step[]).map((s, i) => (

          <span key={s} className={step === s ? 'active' : step === 'done' || i < ['key', 'calibrate', 'condition', 'done'].indexOf(step) ? 'done' : ''}>

            {i + 1}. {s === 'key' ? 'API Key' : s === 'calibrate' ? 'Voice' : s === 'condition' ? 'Preferences' : 'Ready'}

          </span>

        ))}

      </nav>







      {step === 'key' && (

        <section className="panel">

          <h2>AI Provider &amp; API Key</h2>

          <p>

            Your key stays in this browser only. Validation runs here in Options — no service worker required.

          </p>

          <div className="field">

            <label htmlFor="provider">Provider</label>

            <select

              id="provider"

              value={apiProvider}

              onChange={(e) => {

                setApiProvider(e.target.value as Provider);

                setKeyValid(null);

                setKeyMessage(null);

                setKeyWarning(null);

              }}

            >

              <option value="gemini">Google Gemini (multimodal, best for images/video)</option>

              <option value="groq">Groq (fast text inference)</option>

            </select>

          </div>

          {apiProvider === 'gemini' && (

            <div className="field">

              <label htmlFor="gemini-model">Gemini model</label>

              <select

                id="gemini-model"

                value={geminiModel}

                onChange={(e) => {

                  setGeminiModel(e.target.value);

                  setKeyValid(null);

                  setKeyMessage(null);

                  setKeyWarning(null);

                }}

              >

                {SELECTABLE_GEMINI_MODELS.map((id) => (

                  <option key={id} value={id}>

                    {id}

                  </option>

                ))}

              </select>

              <p className="hint">

                Default is gemini-3.1-flash-lite. Pinning disables fallback to other models. gemini-2.5-flash-lite is no longer offered (unavailable on newer Google AI accounts).

              </p>

            </div>

          )}

          <p>{providerMeta.keyHint}</p>

          <a href={providerMeta.keyUrl} target="_blank" rel="noreferrer">

            Get a {providerMeta.label} API key →

          </a>

          <div className="field">

            <input

              type="password"

              value={apiKey}

              onChange={(e) => setApiKey(e.target.value)}

              placeholder={providerMeta.placeholder}

              autoComplete="off"

            />

            <button onClick={() => void validateKey()} disabled={!apiKey.trim() || validating}>

              {validating ? 'Validating…' : 'Validate & Save'}

            </button>

          </div>

          {keyValid === true && <p className="success">{keyMessage ?? 'Key valid ✓'}</p>}

          {keyValid === true && keyWarning && <p className="warn">{keyWarning}</p>}

          {keyValid === false && <p className="error">{keyMessage ?? 'Invalid key — check and retry'}</p>}

        </section>

      )}







      {step === 'calibrate' && (

        <section className="panel">

          <h2>Voice Calibration</h2>

          <p>

            Paste your own replies below to teach the extension your voice. Passive harvesting is off by default —

            enable it only if you want replies captured automatically while scrolling your profile.

          </p>







          <label className="checkbox-row">

            <input

              type="checkbox"

              checked={harvestEnabled}

              onChange={(e) => void toggleHarvestEnabled(e.target.checked)}

            />

            Enable reply harvesting (scroll your X profile → Replies tab)

          </label>







          {harvestEnabled && (

            <p>

              Open <strong>your</strong> X profile → <strong>Replies</strong> tab → scroll for 60 seconds.

              The extension reads reply timelines from GraphQL responses X already loads — no extra requests.

              You should see a small &quot;+1 reply harvested&quot; toast on x.com as replies are captured.

            </p>

          )}







          <p className="corpus-count" aria-live="polite">

            Harvested replies in corpus: <strong>{corpusCount}</strong>

          </p>







          <div className="corpus-actions">

            <button onClick={() => void refreshStyleCard()} disabled={refreshingStyleCard || clearingVoice}>

              {refreshingStyleCard ? 'Refreshing…' : 'Refresh StyleCard'}

            </button>

            <button

              type="button"

              className="danger"

              onClick={() => void clearVoice()}

              disabled={clearingVoice || corpusCount === 0}

            >

              {clearingVoice ? 'Clearing…' : 'Clear voice data'}

            </button>

          </div>

          {clearVoiceMessage && <p className="success">{clearVoiceMessage}</p>}







          <div className="manual-import">

            <h3>Manual fallback</h3>

            <p>

              Paste 3–5 replies you have actually posted (one per line).

            </p>

            <label>

              Your @handle

              <input

                type="text"

                value={manualHandle}

                onChange={(e) => setManualHandle(e.target.value.replace(/^@/, ''))}

                placeholder={styleCard?.sampleHandle ?? 'yourhandle'}

              />

            </label>

            <label>

              Paste replies

              <textarea

                value={manualReplies}

                onChange={(e) => setManualReplies(e.target.value)}

                placeholder={'Love this take — the latency numbers matter more than the benchmark.\nWhat stack are you running this on?\nHard disagree: the bottleneck is IO not compute.'}

                rows={6}

              />

            </label>

            <button onClick={() => void importManual()} disabled={importingManual || !manualReplies.trim()}>

              {importingManual ? 'Importing…' : 'Add to corpus'}

            </button>

            {manualImportMessage && <p className={manualImportMessage.startsWith('Added') ? 'success' : 'warn'}>{manualImportMessage}</p>}

          </div>







          <p className="debug-hint">

            Debug harvest on x.com: open DevTools console and run{' '}

            <code>localStorage.setItem(&apos;xrc_debug_harvest&apos;, &apos;1&apos;)</code>, then reload and scroll your Replies tab.

          </p>







          {styleCardError && <p className="error">{styleCardError}</p>}

          {styleCard && (

            <div className="style-card">

              <h3>Your StyleCard</h3>

              <pre>{formatStyleCardSummary(styleCard)}</pre>

              {styleCard.corpusSize < 6 && (

                <p className="warn">Thin corpus ({styleCard.corpusSize} replies). Keep scrolling or paste examples later.</p>

              )}

            </div>

          )}

          <button className="primary" onClick={() => setStep('condition')}>

            Continue →

          </button>

        </section>

      )}







      {step === 'condition' && (

        <section className="panel">

          <h2>Preferences (optional)</h2>

          <label>

            What you want to be known for

            <textarea

              value={conditioning.knownFor ?? ''}

              onChange={(e) => setConditioning({ ...conditioning, knownFor: e.target.value })}

              placeholder="e.g. practical takes on AI infra"

            />

          </label>

          <label>

            Never mention

            <textarea

              value={conditioning.neverMention ?? ''}

              onChange={(e) => setConditioning({ ...conditioning, neverMention: e.target.value })}

              placeholder="e.g. competitors, politics"

            />

          </label>

          <label>

            Default intent

            <select

              value={conditioning.defaultIntent ?? ''}

              onChange={(e) =>

                setConditioning({

                  ...conditioning,

                  defaultIntent: (e.target.value || undefined) as Conditioning['defaultIntent'],

                })

              }

            >

              <option value="">No bias</option>

              <option value="Add">Add</option>

              <option value="Ask">Ask</option>

              <option value="Push back">Push back</option>

            </select>

          </label>

          <label>

            Daily reply budget

            <input

              type="number"

              min={5}

              max={200}

              value={dailyBudget}

              onChange={(e) => setDailyBudget(Number(e.target.value))}

            />

          </label>

          <button className="primary" onClick={() => void finishOnboarding()}>

            Finish setup →

          </button>

        </section>

      )}







      {step === 'done' && (

        <section className="panel">

          <h2>Ready</h2>

          <p>Open X, view a post, click Reply. Suggestions appear when the composer is focused.</p>

          {apiProvider === 'gemini' && (

            <div className="field">

              <label htmlFor="gemini-model-ready">Gemini model</label>

              <select

                id="gemini-model-ready"

                value={geminiModel}

                onChange={(e) => {

                  const next = e.target.value;

                  setGeminiModel(next);

                  void (async () => {

                    clearGeminiModelOrderCache();

                    await saveSettings({ geminiModel: next });

                    await invalidateComposeCache(apiKey);

                  })();

                }}

              >

                {SELECTABLE_GEMINI_MODELS.map((id) => (

                  <option key={id} value={id}>

                    {id}

                  </option>

                ))}

              </select>

            </div>

          )}

          <p className="subtitle">Provider: {PROVIDER_META[apiProvider].label}</p>

          {apiProvider === 'gemini' && (

            <p className="subtitle">Model: {geminiModel}</p>

          )}

          <ul>

            <li><kbd>⌘1</kbd>/<kbd>⌘2</kbd>/<kbd>⌘3</kbd> — insert suggestion</li>

            <li>Click a suggestion — copy + insert</li>

            <li><kbd>Esc</kbd> — dismiss card</li>

          </ul>

          

        <section className="panel">

          <h2>Usage &amp; spending</h2>

          <p>

            Estimated from Gemini input/output/thinking tokens at Standard paid rates.

            Cache storage ($/hour) is not included. Stamp: {PRICING_STAMP}. 3.5-flash-lite rates are user-verified.

          </p>

          <p className="corpus-count" aria-live="polite">

            Lifetime estimate: <strong>{usage ? formatUsd(usage.totalUsd) : '—'}</strong>

            {' '}· {usage?.totalCalls ?? 0} calls · {(usage?.totalInputTokens ?? 0).toLocaleString()} in /{' '}

            {(usage?.totalOutputTokens ?? 0).toLocaleString()} out

            {(usage?.totalThinkingTokens ?? 0) > 0

              ? ` / ${usage!.totalThinkingTokens.toLocaleString()} thinking`

              : ''}

          </p>

          {usage && Object.keys(usage.byModel).length > 0 ? (

            <table className="usage-table">

              <thead>

                <tr>

                  <th>Model</th>

                  <th>Calls</th>

                  <th>Input</th>

                  <th>Output</th>

                  <th>Thinking</th>

                  <th>Est. USD</th>

                </tr>

              </thead>

              <tbody>

                {Object.entries(usage.byModel).map(([model, row]) => (

                  <tr key={model}>

                    <td>{model}</td>

                    <td>{row.calls}</td>

                    <td>{row.inputTokens.toLocaleString()}</td>

                    <td>{row.outputTokens.toLocaleString()}</td>

                    <td>{row.thinkingTokens.toLocaleString()}</td>

                    <td>{formatUsd(row.estimatedUsd)}</td>

                  </tr>

                ))}

              </tbody>

            </table>

          ) : (

            <p>No billed generations recorded yet. Use the extension on X, then reopen Options.</p>

          )}

          <div className="corpus-actions">

            <button

              onClick={() => {

                void (async () => {

                  setResettingUsage(true);

                  try {

                    setUsage(await resetUsage());

                  } finally {

                    setResettingUsage(false);

                  }

                })();

              }}

              disabled={resettingUsage || !usage || usage.totalCalls === 0}

            >

              {resettingUsage ? 'Resetting…' : 'Reset usage'}

            </button>

            <button

              onClick={() => {

                void (async () => {

                  try {

                    setUsage(await getUsageSummary());

                  } catch {

                    /* ignore */

                  }

                })();

              }}

            >

              Refresh

            </button>

          </div>

        </section>



<div className="disclosure">

            <strong>Data disclosure:</strong> This extension reads posts you view on X (via passive GraphQL interception)

            to generate reply suggestions. {PROVIDER_META[apiProvider].disclosure} Nothing passes through our servers.

          </div>

          <p className="corpus-count" aria-live="polite">

            Harvested replies in corpus: <strong>{corpusCount}</strong>

          </p>







          <label>

            Daily reply budget

            <input

              type="number"

              min={5}

              max={200}

              value={dailyBudget}

              onChange={(e) => setDailyBudget(Number(e.target.value))}

              onBlur={(e) => void saveDailyBudget(Number(e.target.value))}

            />

          </label>

          {displayedRemaining !== null && (

            <p className="corpus-count" aria-live="polite">

              Daily reply budget remaining: <strong>{displayedRemaining}</strong> of {dailyBudget}

            </p>

          )}







          <label className="checkbox-row">

            <input

              type="checkbox"

              checked={harvestEnabled}

              onChange={(e) => void toggleHarvestEnabled(e.target.checked)}

            />

            Enable reply harvesting

          </label>







          {styleCard && (

            <div className="style-card">

              <h3>Current StyleCard</h3>

              <pre>{formatStyleCardSummary(styleCard)}</pre>

            </div>

          )}







          {styleRegen && (

            <div className="style-card">

              <h3>StyleCard before / after (last ~50-post regen)</h3>

              <p className="subtitle">

                Regenerated at {new Date(styleRegen.at).toLocaleString()} after{' '}

                {styleRegen.postedDiffCount} posted replies.

              </p>

              <h4>Before</h4>

              <pre>{formatStyleCardSummary(styleRegen.previous)}</pre>

              <h4>After</h4>

              <pre>{styleRegen.summary || formatStyleCardSummary(styleRegen.current)}</pre>

            </div>

          )}







          <div className="corpus-actions">

            <button

              type="button"

              className="danger"

              onClick={() => void clearVoice()}

              disabled={clearingVoice || corpusCount === 0}

            >

              {clearingVoice ? 'Clearing…' : 'Clear voice data'}

            </button>

          </div>

          {clearVoiceMessage && <p className="success">{clearVoiceMessage}</p>}







          <button onClick={() => setStep('key')}>Edit API Key</button>

          <button onClick={() => setStep('condition')}>Edit Preferences</button>

        </section>

      )}

    </div>

  );

}


