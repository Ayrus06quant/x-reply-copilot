import type {
  ComprehendResult,
  ExtensionMessage,
  ExtensionResponse,
  PostBrief,
  Provider,
  RefinementChip,
  Suggestion,
} from '../lib/types';
import {
  getApiKey,
  getSettings,
  getSessionCache,
  setSessionCache,
  getCachedSuggestions,
  setCachedSuggestions,
  getLastServedSuggestion,
} from '../lib/storage';
import { postBriefHasVisualMedia } from '../lib/post-brief';
import { mediaDebug } from '../lib/debug';
import { DEFAULT_STYLE_CARD, resolveRefinementEffect, sanitizeAuthorHandle } from '../lib/prompts';
import {
  loadStyleCard,
  getExemplarsForCompose,
  harvestReply,
  rebuildStyleCardFromCorpus,
  getAllReplies,
  getCorpusCount,
  importManualReplies,
} from '../lib/corpus';
import { rerankCandidates, rerankWithoutCorpus, summarizeGateFailures, type GateContext } from '../lib/rerank';
import { getAllDiffs, getLastStyleRegen, recordCreateTweet } from '../lib/flywheel';
import { canCompose, checkShapeVariance, recordReplyToAccount, getGovernorStatus } from '../lib/governor';
import { getAiProvider } from '../lib/provider';
import { validateApiKeyForProvider } from '../lib/api-validation';
import { logEntry, now, recordPipelineTiming, since, type PipelineTiming } from '../lib/perf';
import { getUsageSummary, resetUsage } from '../lib/usage';
import { invalidateComposeCache } from '../lib/gemini-cache';
import { clearGeminiModelOrderCache } from '../lib/gemini';

const COMPREHEND_PREFIX = 'comprehend:';

/**
 * Dedup concurrent COMPOSE for the same tweet (post-open prefetch + Reply click).
 * Refinement chips always get a fresh run — they must not share this map.
 */
const composeInflight = new Map<string, Promise<ExtensionResponse>>();

console.debug('[X Reply Copilot] Background module loaded', new Date().toISOString());

/**
 * F3. `chrome.storage.session` defaults to TRUSTED_CONTEXTS, which excludes content
 * scripts, so `setLastServedSuggestion` from `content.ts` always rejected — silently,
 * because the promise was `void`-ed. Without this the flywheel's strongest signal, the
 * diff between what was suggested and what was posted, can never be recorded at all.
 *
 * Guarded because WXT imports this module in Node at build time to read the entrypoint
 * options, and the build-time `chrome` shim has no `setAccessLevel`.
 */
function openSessionStorageToContentScripts(): void {
  const session = chrome.storage?.session as
    | (chrome.storage.SessionStorageArea & {
        setAccessLevel?: (options: { accessLevel: chrome.storage.AccessLevel }) => Promise<void>;
      })
    | undefined;

  if (typeof session?.setAccessLevel !== 'function') {
    console.warn('[X Reply Copilot] storage.session.setAccessLevel unavailable in this runtime');
    return;
  }

  session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' as chrome.storage.AccessLevel })
    .then(() => logEntry('session storage opened to content scripts'))
    .catch((e: unknown) =>
      console.error('[X Reply Copilot] could not open session storage to content scripts', e),
    );
}

async function getOrCreateStyleCard() {
  let card = await loadStyleCard();
  if (!card) {
    card = await rebuildStyleCardFromCorpus();
  }
  return card ?? DEFAULT_STYLE_CARD;
}

async function buildGateContext(postBrief: PostBrief, refinement?: RefinementChip): Promise<GateContext> {
  const styleCard = await getOrCreateStyleCard();
  const replies = await getAllReplies(100);
  const allowedHandles = [postBrief.authorHandle, styleCard.sampleHandle ?? ''].filter(Boolean);

  return {
    styleCard,
    allowedHandles,
    corpusTexts: replies.map((r) => r.text),
    refinement: resolveRefinementEffect(styleCard, refinement),
  };
}

async function resolveProvider(override?: Provider): Promise<Provider> {
  if (override) return override;
  const settings = await getSettings();
  return settings.apiProvider ?? 'gemini';
}

function comprehendMissingImageContext(cached: ComprehendResult, postBrief: PostBrief): boolean {
  if (!postBriefHasVisualMedia(postBrief)) return false;
  const desc = cached.imageDescription?.trim() ?? '';
  if (!desc) return true;
  if (desc === '[object Object]') return true;
  if (
    desc === 'Video post (poster frame only)' &&
    postBrief.media.some((m) => m.type === 'photo')
  ) {
    return true;
  }
  return false;
}

/**
 * A brief scraped from the DOM carries `topReplies: []`, so a comprehend built from it has
 * no avoidance signal. When the interceptor later supplies the real ten, the cached result
 * is stale in the one way the plan singled out as the differentiator, and must be redone.
 */
function comprehendMissingReplyContext(cached: ComprehendResult, postBrief: PostBrief): boolean {
  if (postBrief.topReplies.length === 0) return false;
  return (cached.repliesAlreadySaid?.length ?? 0) === 0;
}

function comprehendIsStale(cached: ComprehendResult, postBrief: PostBrief): boolean {
  return (
    cached.degraded === true ||
    comprehendMissingImageContext(cached, postBrief) ||
    comprehendMissingReplyContext(cached, postBrief)
  );
}

async function withUsageSummary(
  response: ExtensionResponse,
): Promise<ExtensionResponse> {
  if (!response.ok) return response;
  try {
    const usageSummary = await getUsageSummary();
    return { ...response, usageSummary };
  } catch {
    return response;
  }
}

async function handleComprehend(
  postBrief: PostBrief,
  providerOverride?: Provider,
): Promise<ExtensionResponse> {
  const startedAt = now();
  const cacheKey = `${COMPREHEND_PREFIX}${postBrief.tweetId}`;
  const cached = await getSessionCache<ComprehendResult>(cacheKey);

  if (cached && !comprehendIsStale(cached, postBrief)) {
    return withUsageSummary({
      ok: true,
      comprehend: cached,
      timing: {
        at: new Date().toISOString(),
        tweetId: postBrief.tweetId,
        briefSource: postBrief.source,
        comprehendCached: true,
        comprehendMs: since(startedAt),
        topReplyCount: postBrief.topReplies.length,
      },
    });
  }

  if (cached) {
    mediaDebug('re-comprehending — cached result is missing image or reply context', {
      tweetId: postBrief.tweetId,
      mediaCount: postBrief.media.length,
      topReplies: postBrief.topReplies.length,
      degraded: cached.degraded === true,
    });
  }

  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: 'API key not configured' };

  const provider = await resolveProvider(providerOverride);
  const ai = getAiProvider(provider);

  try {
    const comprehend = await ai.comprehendPost(apiKey, postBrief);

    // F10: never cache a degraded fallback for the whole session.
    if (!comprehend.degraded) {
      await setSessionCache(cacheKey, comprehend);
    }

    const timing: PipelineTiming = {
      at: new Date().toISOString(),
      tweetId: postBrief.tweetId,
      briefSource: postBrief.source,
      comprehendCached: false,
      comprehendMs: since(startedAt),
      topReplyCount: postBrief.topReplies.length,
    };
    recordPipelineTiming(timing);

    return withUsageSummary({ ok: true, comprehend, timing });
  } catch (e) {
    console.error('[X Reply Copilot] comprehend failed', e);
    return { ok: false, error: e instanceof Error ? e.message : 'Comprehend failed' };
  }
}

async function enrichGovernorStatus(
  targetHandle: string,
): Promise<{ allowed: boolean; status: Awaited<ReturnType<typeof getGovernorStatus>> }> {
  const { allowed, status } = await canCompose(targetHandle);
  const recent = await getAllDiffs(8);
  const shapeNudge = checkShapeVariance(recent.map((d) => d.postedText).slice(-5));
  if (shapeNudge) {
    status.nudge = status.nudge ? `${status.nudge} ${shapeNudge}` : shapeNudge;
  }
  return { allowed, status };
}

async function handleCompose(
  postBrief: PostBrief,
  refinement?: RefinementChip,
): Promise<ExtensionResponse> {
  // Prefetch + Reply click must share one generation, not pay for two.
  if (!refinement) {
    const inflight = composeInflight.get(postBrief.tweetId);
    if (inflight) return inflight;
  }

  const run = runCompose(postBrief, refinement);
  if (!refinement) {
    composeInflight.set(postBrief.tweetId, run);
    try {
      return await run;
    } finally {
      if (composeInflight.get(postBrief.tweetId) === run) {
        composeInflight.delete(postBrief.tweetId);
      }
    }
  }
  return run;
}

async function runCompose(
  postBrief: PostBrief,
  refinement?: RefinementChip,
): Promise<ExtensionResponse> {
  const composeStartedAt = now();
  const settings = await getSettings();
  const apiKey = settings.apiKey;
  if (!apiKey) return { ok: false, error: 'API key not configured' };

  const governor = await enrichGovernorStatus(postBrief.authorHandle);
  if (!governor.allowed) {
    return { ok: false, error: governor.status.nudge ?? 'Daily budget exceeded' };
  }

  // Session drafts from post-open compose prefetch — Reply click should be a cache hit.
  if (!refinement) {
    const cached = await getCachedSuggestions(postBrief.tweetId);
    const cachedSuggestions = cached?.suggestions as Suggestion[] | undefined;
    if (cachedSuggestions?.length) {
      const timing: PipelineTiming = {
        at: new Date().toISOString(),
        tweetId: postBrief.tweetId,
        briefSource: postBrief.source,
        composeCached: true,
        composeMs: 0,
        composeTotalMs: since(composeStartedAt),
        topReplyCount: postBrief.topReplies.length,
      };
      recordPipelineTiming(timing);
      return withUsageSummary({
        ok: true,
        suggestions: cachedSuggestions,
        governor: governor.status,
        timing,
      });
    }
  }

  const cacheKey = `${COMPREHEND_PREFIX}${postBrief.tweetId}`;
  let comprehend = await getSessionCache<ComprehendResult>(cacheKey);
  let comprehendCached = true;
  let comprehendMs = 0;

  if (!comprehend || comprehendIsStale(comprehend, postBrief)) {
    comprehendCached = false;
    const comprehendStartedAt = now();
    const compResult = await handleComprehend(postBrief, settings.apiProvider);
    comprehendMs = since(comprehendStartedAt);
    if (!compResult.ok || !compResult.comprehend) {
      return compResult.ok ? { ok: false, error: 'Comprehend unavailable' } : compResult;
    }
    comprehend = compResult.comprehend;
  }

  const styleCardPromise = getOrCreateStyleCard();
  const gateCtxPromise = buildGateContext(postBrief, refinement);
  const styleCard = await styleCardPromise;
  const effect = resolveRefinementEffect(styleCard, refinement);
  const exemplars = await getExemplarsForCompose(effect.targetWordCount);
  const username = styleCard.sampleHandle ?? 'user';
  const ai = getAiProvider(settings.apiProvider ?? 'gemini');

  try {
    const generationStartedAt = now();
    const candidates = await ai.composeReplies(apiKey, {
      postBrief,
      comprehend,
      styleCard,
      exemplars,
      conditioning: settings.conditioning,
      refinement,
      username,
    });
    const composeMs = since(generationStartedAt);

    const gateCtx = await gateCtxPromise;
    const suggestions =
      gateCtx.corpusTexts.length >= 5
        ? rerankCandidates(candidates, gateCtx, 3)
        : rerankWithoutCorpus(candidates, gateCtx, 3);

    if (suggestions.length === 0) {
      const reasons = summarizeGateFailures(candidates, gateCtx);
      console.error('[X Reply Copilot] every candidate failed the output gate', {
        candidates: candidates.map((c) => c.text),
        reasons,
        styleCard: gateCtx.styleCard,
      });
      return {
        ok: false,
        error: `Wrote ${candidates.length} drafts but the style gate rejected all of them (${reasons || 'unknown'}). Try a refinement chip, or import replies in Options to widen your style range.`,
      };
    }

    await setCachedSuggestions(postBrief.tweetId, suggestions);

    const timing: PipelineTiming = {
      at: new Date().toISOString(),
      tweetId: postBrief.tweetId,
      briefSource: postBrief.source,
      comprehendCached,
      comprehendMs,
      composeMs,
      composeCached: false,
      composeTotalMs: since(composeStartedAt),
      refinement,
      topReplyCount: postBrief.topReplies.length,
    };
    recordPipelineTiming(timing);

    return withUsageSummary({ ok: true, suggestions, governor: governor.status, comprehend, timing });
  } catch (e) {
    console.error('[X Reply Copilot] compose failed', e);
    return { ok: false, error: e instanceof Error ? e.message : 'Compose failed' };
  }
}

async function handleCreateTweet(message: {
  payload?: {
    fullText?: string;
    inReplyTo?: string;
    inReplyToHandle?: string;
    targetHandle?: string;
    ownHandle?: string;
  };
}): Promise<ExtensionResponse> {
  const created = message.payload ?? {};
  const inReplyTo = created.inReplyTo ?? 'unknown';
  const served = await getLastServedSuggestion(inReplyTo);
  const targetHandle = sanitizeAuthorHandle(
    created.targetHandle || created.inReplyToHandle || 'unknown',
  );
  const ownHandle = created.ownHandle ? sanitizeAuthorHandle(created.ownHandle) : undefined;

  const regen = await recordCreateTweet(
    created.fullText ?? '',
    inReplyTo,
    served?.text,
    served?.index ?? -1,
    ownHandle,
  );

  // F2: count on CreateTweet ground truth with a real handle, not a tweet ID.
  if (created.fullText) {
    await recordReplyToAccount(targetHandle);
  }

  const status = await getGovernorStatus(targetHandle);
  return {
    ok: true,
    governor: status,
    styleCard: regen?.current,
    styleRegen:
      regen?.regenerated && regen.previous && regen.summary
        ? {
            at: Date.now(),
            previous: regen.previous,
            current: regen.current,
            summary: regen.summary,
            postedDiffCount: regen.postedDiffCount ?? 0,
          }
        : undefined,
  };
}

async function handleExtensionMessage(message: unknown): Promise<ExtensionResponse> {
  if ((message as { type?: string }).type === 'CREATE_TWEET') {
    return handleCreateTweet(message as { payload?: Record<string, string | undefined> });
  }

  const msg = message as ExtensionMessage;

  switch (msg.type) {
    case 'PING':
      return { ok: true };

    case 'VALIDATE_API_KEY': {
      const provider = await resolveProvider(msg.provider);
      clearGeminiModelOrderCache();
      const result = await validateApiKeyForProvider(provider, msg.apiKey, msg.geminiModel);
      return {
        ok: true,
        valid: result.valid,
        validationMessage: result.message,
        validationWarning: result.warning,
        validationModel: result.model,
      };
    }

    case 'GET_USAGE_SUMMARY': {
      const usageSummary = await getUsageSummary();
      return { ok: true, usageSummary };
    }

    case 'RESET_USAGE': {
      const usageSummary = await resetUsage();
      return { ok: true, usageSummary };
    }

    case 'COMPREHEND':
      return handleComprehend(msg.postBrief);

    case 'COMPOSE':
      return handleCompose(msg.postBrief, msg.refinement);

    case 'GET_SUGGESTIONS': {
      const cached = await getSessionCache<{ suggestions: Suggestion[] }>(`suggestions:${msg.tweetId}`);
      return cached
        ? { ok: true, suggestions: cached.suggestions }
        : { ok: false, error: 'No cached suggestions' };
    }

    case 'HARVEST_REPLY': {
      const settings = await getSettings();
      if (!settings.harvestEnabled) {
        const corpusCount = await getCorpusCount();
        return { ok: true, added: 0, corpusCount };
      }

      // Sequential on purpose: `harvestReply` dedupes by reading the whole corpus first, so
      // concurrent inserts would race. What changed is that the batch now costs one message
      // instead of one per reply.
      let added = 0;
      for (const reply of msg.replies) {
        if (await harvestReply(reply.text, reply.handle)) added++;
      }

      if (added > 0) {
        await rebuildStyleCardFromCorpus(msg.replies[0]?.handle);
        await invalidateComposeCache(settings.apiKey);
      }

      const corpusCount = await getCorpusCount();
      return { ok: true, added, corpusCount };
    }

    case 'IMPORT_MANUAL_REPLIES': {
      const settings = await getSettings();
      const added = await importManualReplies(msg.text, msg.handle);
      await rebuildStyleCardFromCorpus(msg.handle);
      await invalidateComposeCache(settings.apiKey);
      const corpusCount = await getCorpusCount();
      return { ok: true, added, corpusCount };
    }

    case 'GET_CORPUS_COUNT': {
      const corpusCount = await getCorpusCount();
      return { ok: true, corpusCount };
    }

    case 'GET_STYLE_CARD': {
      const card = await rebuildStyleCardFromCorpus();
      return { ok: true, styleCard: card };
    }

    case 'RECORD_POST': {
      // Alternate path (unused by the live CreateTweet relay). Still must key by handle (F2).
      const { diff, targetHandle } = msg;
      const served = await getLastServedSuggestion(diff.tweetId);
      const handle = sanitizeAuthorHandle(targetHandle || 'unknown');
      const regen = await recordCreateTweet(
        diff.postedText,
        diff.tweetId,
        served?.text ?? diff.suggestionText,
        served?.index ?? diff.suggestionIndex,
        handle === 'unknown' ? undefined : handle,
      );
      await recordReplyToAccount(handle);
      return {
        ok: true,
        styleCard: regen?.current,
        styleRegen:
          regen?.regenerated && regen.previous && regen.summary
            ? {
                at: Date.now(),
                previous: regen.previous,
                current: regen.current,
                summary: regen.summary,
                postedDiffCount: regen.postedDiffCount ?? 0,
              }
            : undefined,
      };
    }

    case 'GET_GOVERNOR_STATUS': {
      const status = await getGovernorStatus(msg.targetHandle);
      return { ok: true, governor: status };
    }

    case 'GET_LAST_STYLE_REGEN': {
      const styleRegen = await getLastStyleRegen();
      return { ok: true, styleRegen };
    }

    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

/** MV3: register synchronously at module load so messages work even during SW startup. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleExtensionMessage(message)
    .then(sendResponse)
    .catch((e) => {
      console.error('[X Reply Copilot] Message handler error:', e);
      sendResponse({ ok: false, error: e instanceof Error ? e.message : 'Internal error' });
    });
  return true;
});

export default defineBackground(() => {
  console.debug('[X Reply Copilot] Service worker started', new Date().toISOString());
  logEntry('service worker — started', new Date().toISOString());
  openSessionStorageToContentScripts();
});
