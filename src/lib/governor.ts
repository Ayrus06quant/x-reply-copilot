import type { StoredSettings } from '../types/messages';
import { checkShapeVariance } from './rerank';

const DEFAULT_DAILY_BUDGET = 50;

interface GovernorState {
  date: string;
  dailyUsed: number;
  accountCounts: Record<string, number>;
  recentShapes: string[];
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getState(): Promise<GovernorState> {
  const key = 'governorState';
  const stored = await chrome.storage.local.get(key);
  const state = stored[key] as GovernorState | undefined;
  const today = todayKey();
  if (!state || state.date !== today) {
    return { date: today, dailyUsed: 0, accountCounts: {}, recentShapes: [] };
  }
  return state;
}

async function saveState(state: GovernorState): Promise<void> {
  await chrome.storage.local.set({ governorState: state });
}

export async function getDailyBudget(): Promise<number> {
  const { dailyBudget } = await chrome.storage.local.get('dailyBudget') as StoredSettings;
  return dailyBudget ?? DEFAULT_DAILY_BUDGET;
}

export async function getGovernorStatus(): Promise<{
  dailyUsed: number;
  dailyBudget: number;
  accountNudges: Record<string, number>;
  canGenerate: boolean;
  shapeWarning: boolean;
}> {
  const state = await getState();
  const budget = await getDailyBudget();
  const nudges: Record<string, number> = {};
  for (const [account, count] of Object.entries(state.accountCounts)) {
    if (count >= 3) nudges[account] = count;
  }
  return {
    dailyUsed: state.dailyUsed,
    dailyBudget: budget,
    accountNudges: nudges,
    canGenerate: state.dailyUsed < budget,
    shapeWarning: !checkShapeVariance(state.recentShapes),
  };
}

export async function checkCanGenerate(_targetHandle?: string): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  const status = await getGovernorStatus();
  if (!status.canGenerate) {
    return { allowed: false, reason: `Daily reply budget reached (${status.dailyBudget}). Try again tomorrow.` };
  }
  if (_targetHandle && (status.accountNudges[_targetHandle] ?? 0) >= 4) {
    return {
      allowed: true,
      reason: `You've replied to @${_targetHandle} ${status.accountNudges[_targetHandle]} times today.`,
    };
  }
  return { allowed: true };
}

export async function recordGeneration(): Promise<void> {
  const state = await getState();
  state.dailyUsed += 1;
  await saveState(state);
}

export async function recordReplyPosted(text: string, targetHandle?: string): Promise<void> {
  const state = await getState();
  state.dailyUsed += 1;
  if (targetHandle) {
    state.accountCounts[targetHandle] = (state.accountCounts[targetHandle] ?? 0) + 1;
  }
  state.recentShapes = [...state.recentShapes.slice(-9), text];
  await saveState(state);
}
