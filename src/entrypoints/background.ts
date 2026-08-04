import type { ExtensionMessage } from '../types/messages';
import type { PostBrief } from '../types/post';
import type { GraphQLTimelineData } from '../types/graphql';
import { extractOwnReplies } from '../lib/interceptor';
import {
  getCachedComprehend,
  loadStyleCardAndConditioning,
  prefetchComprehend,
  runCompose,
  runComprehend,
  validateApiKey,
} from '../lib/gemini';
import {
  checkCanGenerate,
  getGovernorStatus,
  recordGeneration,
  recordReplyPosted,
} from '../lib/governor';
import { computeDiffRatio } from '../lib/rerank';
import {
  addCorpusEntry,
  addPostedDiff,
  getCorpusCount,
} from '../lib/storage';
import {
  deriveStyleCard,
  maybeRegenerateStyleCard,
  wordCount,
} from '../lib/style';

const postCache = new Map<string, PostBrief>();
const suggestionCache = new Map<string, ReturnType<typeof runCompose extends (...args: infer _A) => infer R ? Awaited<R> : never>>();
const lastServedSuggestions = new Map<string, { id: string; text: string }>();

async function handleCorpusHarvest(payload: unknown, ownUserId: string): Promise<void> {
  const data = payload as GraphQLTimelineData;
  const replies = extractOwnReplies(data, ownUserId);
  for (const r of replies) {
    await addCorpusEntry({
      id: r.id,
      text: r.text,
      wordCount: wordCount(r.text),
      createdAt: Date.now(),
      isOwnReply: true,
    });
  }
  const count = await getCorpusCount();
  if (count >= 3 && count % 10 === 0) {
    const card = await deriveStyleCard();
    await chrome.storage.local.set({ styleCard: card });
  }
}

async function handlePostOpened(post: PostBrief): Promise<void> {
  postCache.set(post.id, post);
  prefetchComprehend(post);
}

async function handleReplyClicked(postId: string): Promise<void> {
  const post = postCache.get(postId);
  if (!post) return;

  const check = await checkCanGenerate(post.author.handle);
  if (!check.allowed) return;

  try {
    const comprehend = await getCachedComprehend(postId) ?? await runComprehend(post);
    const { styleCard, conditioning } = await loadStyleCardAndConditioning();
    const suggestions = await runCompose(post, comprehend, styleCard, conditioning);
    suggestionCache.set(postId, suggestions);
    await recordGeneration();

    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'SUGGESTIONS_READY',
          suggestions,
        }).catch(() => {});
      }
    });
  } catch (e) {
    console.error('[X Reply Copilot] Compose prefetch failed:', e);
  }
}

async function getSuggestions(postId: string) {
  const post = postCache.get(postId);
  if (!post) throw new Error('Post not found — open a post first');

  const check = await checkCanGenerate(post.author.handle);
  if (!check.allowed) throw new Error(check.reason ?? 'Rate limit reached');

  let cached = suggestionCache.get(postId);
  if (!cached) {
    const comprehend = await getCachedComprehend(postId) ?? await runComprehend(post);
    const { styleCard, conditioning } = await loadStyleCardAndConditioning();
    cached = await runCompose(post, comprehend, styleCard, conditioning);
    suggestionCache.set(postId, cached);
    await recordGeneration();
  }

  if (cached[0]) {
    lastServedSuggestions.set(postId, { id: cached[0].id, text: cached[0].text });
  }

  return { suggestions: cached, governorReason: check.reason };
}

async function handleCreateTweet(
  text: string,
  inReplyTo?: string,
  suggestionId?: string,
): Promise<void> {
  const served = inReplyTo ? lastServedSuggestions.get(inReplyTo) : undefined;
  const suggestionText = served?.text;
  const diffRatio = suggestionText ? computeDiffRatio(suggestionText, text) : 1;

  await addPostedDiff({
    id: `diff-${Date.now()}`,
    tweetId: inReplyTo ?? 'unknown',
    suggestionId: suggestionId ?? served?.id,
    suggestionText,
    postedText: text,
    diffRatio,
    timestamp: Date.now(),
  });

  await addCorpusEntry({
    id: `posted-${Date.now()}`,
    text,
    wordCount: wordCount(text),
    createdAt: Date.now(),
    isOwnReply: true,
  });

  const post = inReplyTo ? postCache.get(inReplyTo) : undefined;
  await recordReplyPosted(text, post?.author.handle);

  const count = await getCorpusCount();
  const newCard = await maybeRegenerateStyleCard(count);
  if (newCard) {
    const prev = (await chrome.storage.local.get('styleCard')).styleCard;
    await chrome.storage.local.set({
      styleCard: newCard,
      previousStyleCard: prev,
    });
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message.type) {
          case 'POST_OPENED':
            await handlePostOpened(message.post);
            sendResponse({ ok: true });
            break;

          case 'REPLY_CLICKED':
            await handleReplyClicked(message.postId);
            sendResponse({ ok: true });
            break;

          case 'PREFETCH_COMPOSE':
            await handleReplyClicked(message.postId);
            sendResponse({ ok: true });
            break;

          case 'GET_SUGGESTIONS': {
            const { suggestions, governorReason } = await getSuggestions(message.postId);
            sendResponse({
              type: 'SUGGESTIONS',
              suggestions,
              reading: true,
              governorReason,
            });
            break;
          }

          case 'REFINE': {
            const post = postCache.get(message.postId);
            if (!post) throw new Error('Post not found');
            const comprehend = await getCachedComprehend(message.postId) ?? await runComprehend(post);
            const { styleCard, conditioning } = await loadStyleCardAndConditioning();
            const suggestions = await runCompose(post, comprehend, styleCard, conditioning, message.modifier);
            suggestionCache.set(message.postId, suggestions);
            sendResponse({ type: 'SUGGESTIONS', suggestions, reading: true });
            break;
          }

          case 'CREATE_TWEET':
            await handleCreateTweet(message.text, message.inReplyTo, message.suggestionId);
            sendResponse({ ok: true });
            break;

          case 'CORPUS_HARVEST':
            await handleCorpusHarvest(message.payload, message.ownUserId);
            sendResponse({ ok: true });
            break;

          case 'GET_GOVERNOR_STATUS': {
            const status = await getGovernorStatus();
            sendResponse({ type: 'GOVERNOR_STATUS', ...status });
            break;
          }

          case 'GET_STYLE_CARD': {
            const { styleCard, conditioning } = await loadStyleCardAndConditioning();
            sendResponse({ type: 'STYLE_CARD', card: styleCard, conditioning });
            break;
          }

          case 'VALIDATE_API_KEY': {
            const valid = await validateApiKey(message.apiKey);
            sendResponse({ valid });
            break;
          }

          case 'SAVE_SETTINGS':
            await chrome.storage.local.set(message.settings);
            sendResponse({ ok: true });
            break;

          case 'REGENERATE_STYLE_CARD': {
            const card = await deriveStyleCard();
            await chrome.storage.local.set({ styleCard: card });
            sendResponse({ type: 'STYLE_CARD', card, conditioning: (await loadStyleCardAndConditioning()).conditioning });
            break;
          }

          case 'CLIPBOARD_WRITE':
            sendResponse({ ok: true });
            break;

          default:
            sendResponse({ error: 'Unknown message type' });
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        sendResponse({ type: 'SUGGESTIONS_ERROR', error: err });
      }
    })();
    return true;
  });
});
