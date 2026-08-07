import type { UsageSummary } from './types';

const LEDGER_KEY = 'xrcUsageLedger';

/** Stamp shown in Options; 2.5/3.1 match ai.google.dev; 3.5-lite is user-verified. */
export const PRICING_STAMP = '2026-08-07 (Standard paid; 3.5-flash-lite user-verified)';

/** USD per 1M tokens — Standard paid tier. */
export const MODEL_RATES: Record<
  string,
  { inputPerM: number; outputPerM: number; cachedInputPerM: number }
> = {
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4, cachedInputPerM: 0.01 },
  'gemini-3.1-flash-lite': { inputPerM: 0.25, outputPerM: 1.5, cachedInputPerM: 0.025 },
  'gemini-3.5-flash-lite': { inputPerM: 0.3, outputPerM: 2.5, cachedInputPerM: 0.03 },
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5, cachedInputPerM: 0.03 },
};

export type UsageStage = 'vision' | 'comprehend' | 'compose' | 'validate' | 'other';

export interface UsageEvent {
  model: string;
  stage: UsageStage;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
}

interface ModelBucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
  estimatedUsd: number;
}

interface UsageLedger {
  byModel: Record<string, ModelBucket>;
  totalEstimatedUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCalls: number;
  pricingStamp: string;
  updatedAt: number;
}

function emptyLedger(): UsageLedger {
  return {
    byModel: {},
    totalEstimatedUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalThinkingTokens: 0,
    totalCalls: 0,
    pricingStamp: PRICING_STAMP,
    updatedAt: Date.now(),
  };
}

function ratesFor(model: string): { inputPerM: number; outputPerM: number; cachedInputPerM: number } {
  const exact = MODEL_RATES[model];
  if (exact) return exact;
  // Unknown flash: treat like 2.5-flash mid-tier so the dashboard never under-reports.
  return { inputPerM: 0.3, outputPerM: 2.5, cachedInputPerM: 0.03 };
}

export function estimateUsd(event: UsageEvent): number {
  const rates = ratesFor(event.model);
  const cached = Math.min(Math.max(0, event.cachedInputTokens), Math.max(0, event.inputTokens));
  const uncached = Math.max(0, event.inputTokens - cached);
  const out = Math.max(0, event.outputTokens) + Math.max(0, event.thinkingTokens);
  return (
    (uncached / 1_000_000) * rates.inputPerM +
    (cached / 1_000_000) * rates.cachedInputPerM +
    (out / 1_000_000) * rates.outputPerM
  );
}

/**
 * Normalise generateContent usageMetadata or Interactions usage into token counts.
 * Field names vary across routes and SDK revisions.
 */
export function parseUsagePayload(usage: unknown): {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
} {
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedInputTokens: 0 };
  }
  const u = usage as Record<string, unknown>;
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v));
    }
    return 0;
  };

  const inputTokens = num(
    'promptTokenCount',
    'prompt_token_count',
    'total_input_tokens',
    'inputTokenCount',
    'input_tokens',
  );
  const outputTokens = num(
    'candidatesTokenCount',
    'candidates_token_count',
    'total_output_tokens',
    'outputTokenCount',
    'output_tokens',
  );
  const thinkingTokens = num(
    'thoughtsTokenCount',
    'thoughts_token_count',
    'total_thought_tokens',
    'thinkingTokenCount',
  );
  const cachedInputTokens = num(
    'cachedContentTokenCount',
    'cached_content_token_count',
    'cachedContentTokens',
  );

  return { inputTokens, outputTokens, thinkingTokens, cachedInputTokens };
}

async function loadLedger(): Promise<UsageLedger> {
  const result = await chrome.storage.local.get(LEDGER_KEY);
  const stored = result[LEDGER_KEY] as UsageLedger | undefined;
  if (!stored || typeof stored !== 'object') return emptyLedger();
  return {
    ...emptyLedger(),
    ...stored,
    byModel: stored.byModel ?? {},
    pricingStamp: PRICING_STAMP,
  };
}

async function saveLedger(ledger: UsageLedger): Promise<void> {
  await chrome.storage.local.set({ [LEDGER_KEY]: ledger });
}

export async function recordUsage(event: UsageEvent): Promise<UsageSummary> {
  const ledger = await loadLedger();
  const cost = estimateUsd(event);
  const key = event.model || 'unknown';
  const bucket = ledger.byModel[key] ?? {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cachedInputTokens: 0,
    estimatedUsd: 0,
  };
  bucket.calls += 1;
  bucket.inputTokens += Math.max(0, event.inputTokens);
  bucket.outputTokens += Math.max(0, event.outputTokens);
  bucket.thinkingTokens += Math.max(0, event.thinkingTokens);
  bucket.cachedInputTokens += Math.max(0, event.cachedInputTokens);
  bucket.estimatedUsd += cost;
  ledger.byModel[key] = bucket;
  ledger.totalCalls += 1;
  ledger.totalInputTokens += Math.max(0, event.inputTokens);
  ledger.totalOutputTokens += Math.max(0, event.outputTokens);
  ledger.totalThinkingTokens += Math.max(0, event.thinkingTokens);
  ledger.totalEstimatedUsd += cost;
  ledger.updatedAt = Date.now();
  ledger.pricingStamp = PRICING_STAMP;
  await saveLedger(ledger);
  return toSummary(ledger);
}

export async function getUsageSummary(): Promise<UsageSummary> {
  return toSummary(await loadLedger());
}

export async function resetUsage(): Promise<UsageSummary> {
  const ledger = emptyLedger();
  await saveLedger(ledger);
  return toSummary(ledger);
}

function toSummary(ledger: UsageLedger): UsageSummary {
  return {
    totalUsd: ledger.totalEstimatedUsd,
    totalInputTokens: ledger.totalInputTokens,
    totalOutputTokens: ledger.totalOutputTokens,
    totalThinkingTokens: ledger.totalThinkingTokens,
    totalCalls: ledger.totalCalls,
    byModel: { ...ledger.byModel },
    pricingStamp: ledger.pricingStamp,
  };
}

export function formatUsd(amount: number): string {
  if (amount < 0.001 && amount > 0) return `~$${amount.toFixed(5)}`;
  if (amount < 0.01) return `~$${amount.toFixed(4)}`;
  return `~$${amount.toFixed(3)}`;
}
