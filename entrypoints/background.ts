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

  setCachedSuggestions,

  getLastServedSuggestion,

} from '../lib/storage';

import { postBriefHasVisualMedia } from '../lib/post-brief';
import { mediaDebug } from '../lib/debug';

import { DEFAULT_STYLE_CARD } from '../lib/prompts';

import { loadStyleCard, getExemplarsForCompose, harvestReply, rebuildStyleCardFromCorpus, getAllReplies, getCorpusCount, importManualReplies } from '../lib/corpus';

import { rerankCandidates, rerankWithoutCorpus, summarizeGateFailures, type GateContext } from '../lib/rerank';

import { recordCreateTweet } from '../lib/flywheel';

import { canCompose, recordReplyToAccount, getGovernorStatus } from '../lib/governor';

import { getAiProvider } from '../lib/provider';

import { validateApiKeyForProvider } from '../lib/api-validation';



const COMPREHEND_PREFIX = 'comprehend:';

console.error('[X Reply Copilot] Background module loaded', new Date().toISOString());

async function getOrCreateStyleCard() {

  let card = await loadStyleCard();

  if (!card) {

    card = await rebuildStyleCardFromCorpus();

  }

  return card ?? DEFAULT_STYLE_CARD;

}

async function buildGateContext(postBrief: PostBrief): Promise<GateContext> {

  const styleCard = await getOrCreateStyleCard();

  const replies = await getAllReplies(100);

  const allowedHandles = [

    postBrief.authorHandle,

    styleCard.sampleHandle ?? '',

  ].filter(Boolean);



  return {

    styleCard,

    allowedHandles,

    corpusTexts: replies.map((r) => r.text),

  };

}

async function resolveProvider(override?: Provider): Promise<Provider> {

  if (override) return override;

  const settings = await getSettings();

  return settings.apiProvider ?? 'gemini';

}

function comprehendMissingImageContext(
  cached: ComprehendResult,
  postBrief: PostBrief,
): boolean {
  if (!postBriefHasVisualMedia(postBrief)) return false;
  const desc = cached.imageDescription?.trim() ?? '';
  if (!desc) return true;
  if (desc === '[object Object]') return true;
  if (
    desc === 'Video post (poster frame only)' &&
    postBrief.media.some((m) => m.type === 'photo' || m.type === 'animated_gif')
  ) {
    return true;
  }
  return false;
}

async function handleComprehend(postBrief: PostBrief, providerOverride?: Provider): Promise<ExtensionResponse> {

  const cacheKey = `${COMPREHEND_PREFIX}${postBrief.tweetId}`;

  const cached = await getSessionCache<ComprehendResult>(cacheKey);

  if (cached && !comprehendMissingImageContext(cached, postBrief)) {
    return { ok: true, comprehend: cached };
  }

  if (cached && comprehendMissingImageContext(cached, postBrief)) {
    mediaDebug('re-comprehending — cached imageDescription empty but post has media', {
      tweetId: postBrief.tweetId,
      mediaCount: postBrief.media.length,
    });
  }

  const apiKey = await getApiKey();

  if (!apiKey) return { ok: false, error: 'API key not configured' };



  const provider = await resolveProvider(providerOverride);

  const ai = getAiProvider(provider);



  try {

    const comprehend = await ai.comprehendPost(apiKey, postBrief);

    await setSessionCache(cacheKey, comprehend);

    return { ok: true, comprehend };

  } catch (e) {

    console.error('[X Reply Copilot] comprehend failed', e);

    return { ok: false, error: e instanceof Error ? e.message : 'Comprehend failed' };

  }

}



async function handleCompose(

  postBrief: PostBrief,

  refinement?: RefinementChip,

): Promise<ExtensionResponse> {

  const settings = await getSettings();

  const apiKey = settings.apiKey;

  if (!apiKey) return { ok: false, error: 'API key not configured' };



  const governor = await canCompose(postBrief.authorHandle);

  if (!governor.allowed) {

    return { ok: false, error: governor.status.nudge ?? 'Daily budget exceeded' };

  }



  const cacheKey = `${COMPREHEND_PREFIX}${postBrief.tweetId}`;

  let comprehend = await getSessionCache<ComprehendResult>(cacheKey);

  if (!comprehend || comprehendMissingImageContext(comprehend, postBrief)) {

    const compResult = await handleComprehend(postBrief, settings.apiProvider);

    if (!compResult.ok || !compResult.comprehend) {

      return compResult.ok ? { ok: false, error: 'Comprehend unavailable' } : compResult;

    }

    comprehend = compResult.comprehend;

  }



  const styleCard = await getOrCreateStyleCard();

  const exemplars = await getExemplarsForCompose(styleCard.medianWordCount);

  const username = styleCard.sampleHandle ?? 'user';

  const ai = getAiProvider(settings.apiProvider ?? 'gemini');



  try {

    const candidates = await ai.composeReplies(apiKey, {

      postBrief,

      comprehend,

      styleCard,

      exemplars,

      conditioning: settings.conditioning,

      refinement,

      username,

    });



    const gateCtx = await buildGateContext(postBrief);

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

    return { ok: true, suggestions, governor: governor.status };

  } catch (e) {

    console.error('[X Reply Copilot] compose failed', e);

    return { ok: false, error: e instanceof Error ? e.message : 'Compose failed' };

  }

}



async function handleExtensionMessage(message: unknown): Promise<ExtensionResponse> {

  if ((message as { type?: string }).type === 'CREATE_TWEET') {

    const created = (message as { payload: { fullText: string; inReplyTo?: string } }).payload;

    const inReplyTo = created.inReplyTo ?? 'unknown';

    const served = await getLastServedSuggestion(inReplyTo);

    await recordCreateTweet(created.fullText, inReplyTo, served?.text, served?.index ?? -1);

    return { ok: true };

  }



  const msg = message as ExtensionMessage;



  switch (msg.type) {

    case 'PING':

      return { ok: true };

    case 'VALIDATE_API_KEY': {

      const provider = await resolveProvider(msg.provider);

      const result = await validateApiKeyForProvider(provider, msg.apiKey);

      return {

        ok: true,

        valid: result.valid,

        validationMessage: result.message,

        validationWarning: result.warning,

        validationModel: result.model,

      };

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
        return { ok: true, added: false, corpusCount };
      }

      const added = await harvestReply(msg.text, msg.handle);

      const corpusCount = await getCorpusCount();

      return { ok: true, added, corpusCount };

    }

    case 'IMPORT_MANUAL_REPLIES': {

      const added = await importManualReplies(msg.text, msg.handle);

      await rebuildStyleCardFromCorpus(msg.handle);

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

      const { diff } = msg;

      const served = await getLastServedSuggestion(diff.tweetId);

      const regen = await recordCreateTweet(

        diff.postedText,

        diff.tweetId,

        served?.text ?? diff.suggestionText,

        served?.index ?? diff.suggestionIndex,

      );

      await recordReplyToAccount(diff.tweetId);

      return {

        ok: true,

        styleCard: regen?.current,

      };

    }

    case 'GET_GOVERNOR_STATUS': {

      const status = await getGovernorStatus(msg.targetHandle);

      return { ok: true, governor: status };

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

  console.error('[X Reply Copilot] Service worker started', new Date().toISOString());

});

