import { useCallback, useEffect, useState } from 'react';

import type { Conditioning, Provider, StyleCard } from '../../lib/types';

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



  const providerMeta = PROVIDER_META[apiProvider];



  useEffect(() => {

    void (async () => {

      const settings = await getSettings();

      if (settings.apiProvider) setApiProvider(settings.apiProvider);

      if (settings.apiKey) setApiKey(settings.apiKey);

      if (settings.conditioning) setConditioning(settings.conditioning);

      setDailyBudget(settings.dailyReplyBudget);

      setHarvestEnabled(settings.harvestEnabled ?? false);

      if (settings.onboardingComplete) setStep('done');

      else if (settings.apiKey) setStep('calibrate');



      try {

        const card = await readStyleCardDirect();

        setStyleCard(card);

        setCorpusCount(card.corpusSize);

      } catch (e) {

        setStyleCardError(

          e instanceof Error ? e.message : 'Could not read voice profile from local storage',

        );

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

      const result = await validateApiKeyForProvider(apiProvider, trimmedKey);



      setKeyValid(result.valid);

      setKeyMessage(result.message);

      setKeyWarning(result.warning ?? null);



      if (result.valid) {

        await saveSettings({ apiKey: trimmedKey, apiProvider });

        setStep('calibrate');

      }

    } catch (e) {

      setKeyValid(false);

      setKeyMessage(e instanceof Error ? e.message : 'Validation failed — check your network');

    } finally {

      setValidating(false);

    }

  }, [apiKey, apiProvider, providerMeta.label]);



  const refreshStyleCard = useCallback(async () => {

    setRefreshingStyleCard(true);

    setStyleCardError(null);



    try {

      const count = await getCorpusCount();

      setCorpusCount(count);

      const card = await rebuildStyleCardFromCorpus();

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



  const finishOnboarding = useCallback(async () => {

    await saveSettings({

      conditioning,

      dailyReplyBudget: dailyBudget,

      onboardingComplete: true,

    });

    setStep('done');

  }, [conditioning, dailyBudget]);



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

          <p className="subtitle">Provider: {PROVIDER_META[apiProvider].label}</p>

          <ul>

            <li><kbd>⌘1</kbd>/<kbd>⌘2</kbd>/<kbd>⌘3</kbd> — insert suggestion</li>

            <li>Click a suggestion — copy + insert</li>

            <li><kbd>Esc</kbd> — dismiss card</li>

          </ul>

          <div className="disclosure">

            <strong>Data disclosure:</strong> This extension reads posts you view on X (via passive GraphQL interception)

            to generate reply suggestions. {PROVIDER_META[apiProvider].disclosure} Nothing passes through our servers.

          </div>

          <p className="corpus-count" aria-live="polite">

            Harvested replies in corpus: <strong>{corpusCount}</strong>

          </p>



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

