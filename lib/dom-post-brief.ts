import { buildImageUrl, isGifPosterUrl } from './media';
import type { MediaItem, PostBrief, ReplySnippet } from './types';

/** The plan asks for the top 10. "Top 20" appears only in the X API cost calculation. */
const TOP_REPLY_LIMIT = 10;
/** Bounded so a long conversation cannot turn a reply click into a full-page scrape. */
const MAX_REPLY_ARTICLES_SCANNED = 40;

/**
 * Degraded replacement for the GraphQL reply timeline, under P6. `topReplies` was
 * hardcoded to `[]` here, so the avoidance signal the plan named as the differentiator —
 * "telling the model 'these six things have already been said'" — was empty on the only
 * path that ever ran. This reads what is actually on screen instead.
 *
 * Strictly poorer than the GraphQL path: no like counts, so no relevance ranking, and only
 * the replies X has already rendered.
 */
function extractVisibleReplies(focalArticle: Element, authorHandle: string): ReplySnippet[] {
  if (!/\/status\/\d+/.test(window.location.pathname)) return [];

  const replies: ReplySnippet[] = [];
  const seen = new Set<string>();
  const articles = document.querySelectorAll('article[data-testid="tweet"]');

  let scanned = 0;
  for (const article of articles) {
    if (replies.length >= TOP_REPLY_LIMIT) break;
    if (scanned++ >= MAX_REPLY_ARTICLES_SCANNED) break;
    if (article === focalArticle) continue;

    // Only what comes after the focal post in document order is a reply to it.
    const position = focalArticle.compareDocumentPosition(article);
    if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) continue;

    const text = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? '';
    if (!text || seen.has(text)) continue;

    const handleHref =
      article
        .querySelector('[data-testid="User-Name"]')
        ?.querySelector('a[href^="/"]')
        ?.getAttribute('href') ?? '';
    const handle = handleHref.match(/^\/([^/?#]+)/)?.[1] ?? 'unknown';
    if (handle.toLowerCase() === authorHandle.toLowerCase()) continue;

    seen.add(text);
    replies.push({ handle, text });
  }

  return replies;
}

function extractMediaFromTweetElement(article: Element, postHasText: boolean): MediaItem[] {
  const items: MediaItem[] = [];
  const seen = new Set<string>();

  const imgs = article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com"]');
  for (const img of imgs) {
    const src = img.getAttribute('src');
    if (!src || src.includes('profile_images') || src.includes('emoji')) continue;

    const base = src.split('?')[0]!;
    if (seen.has(base)) continue;
    seen.add(base);

    const alt = img.getAttribute('alt')?.trim();
    items.push({
      type: 'photo',
      url: src.includes('format=') ? src : buildImageUrl(base, undefined, postHasText),
      altText: alt && alt !== 'Image' ? alt : undefined,
    });
  }

  const videoPosters = article.querySelectorAll<HTMLVideoElement>('video[poster*="pbs.twimg.com"]');
  for (const video of videoPosters) {
    const poster = video.getAttribute('poster');
    if (!poster || seen.has(poster)) continue;
    seen.add(poster);

    // X renders animated GIFs as looping <video>; tweet_video_thumb is the GIF poster path.
    const type: MediaItem['type'] = isGifPosterUrl(poster) ? 'animated_gif' : 'video';
    const aria =
      video.getAttribute('aria-label')?.trim() ||
      video.closest('[aria-label]')?.getAttribute('aria-label')?.trim();
    const altText =
      aria && !/^(video|gif|animated gif)$/i.test(aria) ? aria : undefined;

    items.push({
      type,
      url: poster.includes('format=')
        ? poster
        : buildImageUrl(poster.split('?')[0]!, undefined, postHasText),
      altText,
    });
  }

  return items;
}

/** Extract PostBrief from a tweet article element in the X DOM. */
export function extractPostBriefFromTweetElement(tweetEl: Element): PostBrief | null {
  const article =
    tweetEl.closest('article[data-testid="tweet"]') ?? tweetEl.closest('article');
  if (!article) return null;

  const textEl = article.querySelector('[data-testid="tweetText"]');
  const text = textEl?.textContent?.trim() ?? '';

  const timeLink = article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
  const href = timeLink?.getAttribute('href') ?? '';
  const statusMatch = href.match(/\/status\/(\d+)/);
  const tweetId = statusMatch?.[1] ?? '';
  if (!tweetId) return null;

  const media = extractMediaFromTweetElement(article, text.length > 0);
  if (!text && media.length === 0) return null;

  const userNameEl = article.querySelector('[data-testid="User-Name"]');
  const handleLink = userNameEl?.querySelector('a[href^="/"]') as HTMLAnchorElement | null;
  const handleHref = handleLink?.getAttribute('href') ?? '';
  const handleMatch = handleHref.match(/^\/([^/?#]+)/);
  const authorHandle = handleMatch?.[1] ?? 'unknown';

  const authorName =
    userNameEl?.querySelector('span span')?.textContent?.trim() ??
    userNameEl?.textContent?.trim()?.split('\n')[0]?.trim() ??
    authorHandle;

  return {
    tweetId,
    authorHandle,
    authorName,
    text,
    media,
    topReplies: extractVisibleReplies(article, authorHandle),
    url: `https://x.com/${authorHandle}/status/${tweetId}`,
    source: 'dom',
  };
}

/** Best-effort: find the tweet being replied to when the composer is open. */
export function findReplyTargetFromDom(): PostBrief | null {
  const composer = document.querySelector('[data-testid="tweetTextarea_0"]');
  if (!composer) return null;

  const dialog = composer.closest('[role="dialog"]');
  if (dialog) {
    const tweet = dialog.querySelector('article[data-testid="tweet"]');
    if (tweet) return extractPostBriefFromTweetElement(tweet);
  }

  // Inline reply: walk up from composer and take the nearest preceding tweet article.
  let node: Element | null = composer;
  while (node && node !== document.body) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;

    const articles = parent.querySelectorAll('article[data-testid="tweet"]');
    if (articles.length > 0) {
      let closest: Element | null = null;
      for (const article of articles) {
        if (
          article.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_PRECEDING
        ) {
          if (!closest || article.compareDocumentPosition(closest) & Node.DOCUMENT_POSITION_FOLLOWING) {
            closest = article;
          }
        }
      }
      if (closest) return extractPostBriefFromTweetElement(closest);
    }
    node = parent;
  }

  return null;
}

