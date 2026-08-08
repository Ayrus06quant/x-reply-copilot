import type { GovernorState, GovernorStatus } from './types';
import { getSettings } from './storage';

const GOVERNOR_KEY = 'governor_state';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadState(): Promise<GovernorState> {
  const result = await chrome.storage.local.get(GOVERNOR_KEY);
  const stored = result[GOVERNOR_KEY] as GovernorState | undefined;
  const today = todayKey();

  if (!stored || stored.date !== today) {
    return { date: today, replyCount: 0, accountCounts: {} };
  }
  return stored;
}

async function saveState(state: GovernorState): Promise<void> {
  await chrome.storage.local.set({ [GOVERNOR_KEY]: state });
}

export async function recordReplyToAccount(handle: string): Promise<GovernorState> {
  const state = await loadState();
  const key = handle.toLowerCase();
  state.replyCount++;
  state.accountCounts[key] = (state.accountCounts[key] ?? 0) + 1;
  await saveState(state);
  return state;
}

export async function getGovernorStatus(targetHandle: string): Promise<GovernorStatus> {
  const settings = await getSettings();
  const state = await loadState();
  const budget = settings.dailyReplyBudget;
  const accountKey = targetHandle.toLowerCase();
  const accountCount = state.accountCounts[accountKey] ?? 0;
  const remaining = Math.max(0, budget - state.replyCount);

  const status: GovernorStatus = {
    remainingBudget: remaining,
    accountReplyCount: accountCount,
  };

  // Hard daily budget only. Per-handle soft nudges ("Consider varying your targets")
  // were removed — the user may reply to the same account as often as they want.
  // `accountReplyCount` (and settings.accountNudgeThreshold) remain for counters/storage.
  if (remaining <= 0) {
    status.blocked = true;
    status.nudge = `Daily reply budget (${budget}) reached. Take a break to avoid pattern detection.`;
  }

  return status;
}

/** Shape variance check — flag if last N replies share identical structure. */
export function checkShapeVariance(recentTexts: string[]): string | undefined {
  if (recentTexts.length < 3) return undefined;

  const shapes = recentTexts.map((t) => {
    const words = t.trim().split(/\s+/);
    const len = words.length < 8 ? 'short' : words.length < 20 ? 'medium' : 'long';
    const endsQ = t.trim().endsWith('?') ? 'q' : 's';
    const startsLower = /^[a-z]/.test(t.trim()) ? 'l' : 'u';
    return `${len}-${endsQ}-${startsLower}`;
  });

  const unique = new Set(shapes);
  if (unique.size === 1) {
    return 'Your recent replies share the same shape. Try varying length or structure.';
  }
  return undefined;
}

export async function canCompose(targetHandle: string): Promise<{ allowed: boolean; status: GovernorStatus }> {
  const status = await getGovernorStatus(targetHandle);
  return { allowed: !status.blocked, status };
}
