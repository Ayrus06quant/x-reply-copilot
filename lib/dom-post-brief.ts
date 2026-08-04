import { buildImageUrl } from './media';
import type { MediaItem, PostBrief } from './types';

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

    items.push({
      type: 'video',
      url: poster.includes('format=') ? poster : buildImageUrl(poster.split('?')[0]!, undefined, postHasText),
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
    topReplies: [],
    url: `https://x.com/${authorHandle}/status/${tweetId}`,
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
    const parent = node.parentElement;
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
