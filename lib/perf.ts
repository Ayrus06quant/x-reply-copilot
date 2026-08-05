/**
 * Execution proof and latency instrumentation.
 *
 * Backlog item 1. Before this file, `performance.now(` had zero occurrences in the
 * repository and no entrypoint logged unconditionally, which is how a MAIN-world
 * module went un-executed for the life of the project without anyone noticing.
 *
 * Two separate jobs:
 *   `logEntry`  — one always-on line per execution context, so "is it running" is
 *                 answerable in one glance instead of four rounds of debugging.
 *   `PipelineTiming` — the capture / comprehend / compose marks measured against the
 *                 700-1200 ms motor-time window.
 */

const ENTRY_PREFIX = '[XRC Entry]';
const PERF_PREFIX = '[XRC Perf]';

/** Read back with: chrome.storage.local.get('xrcLastPipelineTiming', console.log) */
export const PIPELINE_TIMING_KEY = 'xrcLastPipelineTiming';

/**
 * Always on, in every context, never behind a debug flag. A gated proof-of-execution
 * log is not a proof of execution.
 */
export function logEntry(context: string, detail?: unknown): void {
  if (detail === undefined) {
    console.info(`${ENTRY_PREFIX} ${context}`);
  } else {
    console.info(`${ENTRY_PREFIX} ${context}`, detail);
  }
}

/** `performance` exists in page, content-script and service-worker realms. */
export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Elapsed milliseconds since a `now()` mark, rounded to 0.1 ms. */
export function since(start: number): number {
  return Math.round((now() - start) * 10) / 10;
}

export interface PipelineTiming {
  at: string;
  tweetId: string;
  /** 'graphql' means the MAIN-world interceptor supplied the brief; 'dom' means degraded. */
  briefSource?: 'graphql' | 'dom';
  /** Provider wall clock for Stage 1. Absent when the session cache was hit. */
  comprehendMs?: number;
  comprehendCached?: boolean;
  /** Provider wall clock for Stage 2 (generation only). */
  composeMs?: number;
  /** Whole COMPOSE handler in the service worker, including Stage 1 when it ran serially. */
  composeTotalMs?: number;
  /** True when Stage 2 returned session-cached suggestions (compose prefetch hit). */
  composeCached?: boolean;
  /** Reply click to rendered card, measured in the content script. */
  clickToCardMs?: number;
  /** Post open to Comprehend resolved — the number the prefetch design lives or dies on. */
  postOpenToComprehendMs?: number;
  /** Post open to Compose prefetch resolved — drafts ready before Reply. */
  postOpenToComposeMs?: number;
  refinement?: string;
  topReplyCount?: number;
}

export function logTiming(label: string, timing: Record<string, unknown>): void {
  console.info(`${PERF_PREFIX} ${label}`, timing);
}

/**
 * Persisted in the style of `xrcLastGenerationDebug` (lib/debug.ts) so a latency claim
 * can be checked after the fact rather than re-measured by hand.
 */
export function recordPipelineTiming(timing: PipelineTiming): void {
  console.info(`${PERF_PREFIX} pipeline`, timing);
  try {
    chrome.storage?.local
      ?.set({ [PIPELINE_TIMING_KEY]: timing })
      .catch((e: unknown) => console.warn(`${PERF_PREFIX} could not persist timing`, e));
  } catch (e) {
    console.warn(`${PERF_PREFIX} timing storage unavailable`, e);
  }
}
