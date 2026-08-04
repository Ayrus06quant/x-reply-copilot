import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { StyleCard, UserConditioning } from '../types/style';
import { DEFAULT_STYLE_CARD } from '../types/style';

function App() {
  const [apiKey, setApiKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<'idle' | 'valid' | 'invalid' | 'checking'>('idle');
  const [knownFor, setKnownFor] = useState('');
  const [neverMention, setNeverMention] = useState('');
  const [defaultIntent, setDefaultIntent] = useState<UserConditioning['defaultIntent']>('Add');
  const [dailyBudget, setDailyBudget] = useState(50);
  const [disclosureAccepted, setDisclosureAccepted] = useState(false);
  const [styleCard, setStyleCard] = useState<StyleCard>(DEFAULT_STYLE_CARD);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.storage.local.get([
      'geminiApiKey',
      'conditioning',
      'dailyBudget',
      'disclosureAccepted',
      'styleCard',
      'onboardingComplete',
    ]).then((data) => {
      if (data.geminiApiKey) setApiKey(data.geminiApiKey);
      const cond = data.conditioning as UserConditioning | undefined;
      if (cond) {
        setKnownFor(cond.knownFor);
        setNeverMention(cond.neverMention);
        setDefaultIntent(cond.defaultIntent);
      }
      if (data.dailyBudget) setDailyBudget(data.dailyBudget);
      if (data.disclosureAccepted) setDisclosureAccepted(true);
      if (data.styleCard) setStyleCard(data.styleCard as StyleCard);
    });
  }, []);

  async function validateKey(key: string) {
    setKeyStatus('checking');
    const resp = await chrome.runtime.sendMessage({ type: 'VALIDATE_API_KEY', apiKey: key });
    setKeyStatus(resp?.valid ? 'valid' : 'invalid');
    return resp?.valid ?? false;
  }

  async function save() {
    if (!disclosureAccepted) {
      alert('Please accept the data collection disclosure to continue.');
      return;
    }
    if (apiKey) {
      const valid = await validateKey(apiKey);
      if (!valid) return;
    }
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: {
        geminiApiKey: apiKey,
        conditioning: { knownFor, neverMention, defaultIntent },
        dailyBudget,
        disclosureAccepted,
        onboardingComplete: true,
      },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function regenerateStyleCard() {
    const resp = await chrome.runtime.sendMessage({ type: 'REGENERATE_STYLE_CARD' });
    if (resp?.card) setStyleCard(resp.card);
  }

  return (
    <div className="container">
      <header>
        <h1>X Reply Copilot</h1>
        <p className="subtitle">Human-in-the-loop reply suggestions in your measured voice</p>
      </header>

      <section className="disclosure">
        <h2>Data Collection Disclosure</h2>
        <p>
          This extension reads posts you view on X (x.com) by intercepting GraphQL responses in your
          browser. Post content is sent to Google Gemini using <strong>your own API key</strong> to
          generate reply suggestions. No data is sent to our servers.
        </p>
        <p>
          A visible &ldquo;Reading this post&rdquo; indicator appears while a post is being analyzed.
          Suggestions appear only when you open the reply composer.
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={disclosureAccepted}
            onChange={(e) => setDisclosureAccepted(e.target.checked)}
          />
          I understand and accept this data collection
        </label>
      </section>

      <section>
        <h2>1. Gemini API Key</h2>
        <p className="hint">
          Get a key at{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            Google AI Studio
          </a>
          . Use a paid tier (~$0.50/month for heavy use). Key is stored locally only — never synced.
        </p>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setKeyStatus('idle'); }}
          placeholder="AIza..."
          className="input"
        />
        <button type="button" onClick={() => validateKey(apiKey)} className="btn secondary">
          Validate
        </button>
        {keyStatus === 'checking' && <span className="status">Checking…</span>}
        {keyStatus === 'valid' && <span className="status ok">✓ Valid</span>}
        {keyStatus === 'invalid' && <span className="status err">✗ Invalid key</span>}
      </section>

      <section>
        <h2>2. Voice Calibration</h2>
        <p className="hint">
          Open your X profile → Replies tab → scroll for 60 seconds. The extension harvests your past
          replies from GraphQL payloads X already fetches (zero extra requests).
        </p>
        <div className="style-card">
          <h3>Your StyleCard {styleCard.sampleCount > 0 ? `(${styleCard.sampleCount} replies)` : '(default)'}</h3>
          <ul>
            <li>Average length: {styleCard.medianWordCount} words (p75: {styleCard.p75WordCount})</li>
            <li>Emoji rate: {(styleCard.emojiRate * 100).toFixed(1)}%</li>
            <li>Lowercase openers: {(styleCard.lowercaseOpenerRate * 100).toFixed(0)}%</li>
            <li>Contractions: {(styleCard.contractionRate * 100).toFixed(0)}%</li>
            <li>Openers: {styleCard.openers.join(', ') || 'none yet'}</li>
            <li>Signature phrases: {styleCard.signaturePhrases.join(', ') || 'none yet'}</li>
          </ul>
          <button type="button" onClick={regenerateStyleCard} className="btn secondary">
            Regenerate StyleCard
          </button>
        </div>
      </section>

      <section>
        <h2>3. Conditioning (optional)</h2>
        <label>
          Known for
          <input
            value={knownFor}
            onChange={(e) => setKnownFor(e.target.value)}
            placeholder="e.g. indie hacking, climate policy"
            className="input"
          />
        </label>
        <label>
          Never mention
          <input
            value={neverMention}
            onChange={(e) => setNeverMention(e.target.value)}
            placeholder="e.g. competitors, politics"
            className="input"
          />
        </label>
        <label>
          Default intent
          <select value={defaultIntent} onChange={(e) => setDefaultIntent(e.target.value as UserConditioning['defaultIntent'])}>
            <option value="Add">Add</option>
            <option value="Ask">Ask</option>
            <option value="Push back">Push back</option>
          </select>
        </label>
      </section>

      <section>
        <h2>4. Rate Governor</h2>
        <label>
          Daily reply budget
          <input
            type="number"
            min={5}
            max={100}
            value={dailyBudget}
            onChange={(e) => setDailyBudget(parseInt(e.target.value, 10) || 50)}
            className="input narrow"
          />
        </label>
        <p className="hint">Hard visible budget to avoid pattern-based enforcement on X.</p>
      </section>

      <section>
        <h2>Keyboard Shortcuts</h2>
        <ul className="shortcuts">
          <li><kbd>⌘/Ctrl</kbd> + <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> — Insert suggestion</li>
          <li><kbd>Esc</kbd> — Dismiss suggestion card</li>
        </ul>
      </section>

      <footer>
        <button type="button" onClick={save} className="btn primary">
          Save Settings
        </button>
        {saved && <span className="status ok">Saved!</span>}
      </footer>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
