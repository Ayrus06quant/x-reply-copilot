import { dig } from './graphql-parser';
import type { MediaItem, VideoVariant } from './types';

interface RawMedia {
  type?: string;
  media_url_https?: string;
  ext_alt_text?: string | { alt_text?: string };
  sizes?: Record<string, { w?: number; h?: number }>;
  video_info?: {
    variants?: Array<{ url?: string; content_type?: string; bitrate?: number }>;
  };
}

/** GraphQL may send ext_alt_text as a string or { alt_text: string }. */
export function parseAltText(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }
  if (raw && typeof raw === 'object' && 'alt_text' in raw) {
    const trimmed = String((raw as { alt_text?: string }).alt_text ?? '').trim();
    return trimmed || undefined;
  }
  return undefined;
}

/** Build sized pbs.twimg.com URL with optional medium escalation. */
export function buildImageUrl(
  baseUrl: string,
  sizes?: Record<string, { w?: number; h?: number }>,
  postHasText = true,
): string {
  const large = sizes?.large;
  const useMedium =
    !postHasText && large?.w != null && large.w > 1500;

  const name = useMedium ? 'medium' : 'small';
  const clean = baseUrl.split('?')[0];
  return `${clean}?format=webp&name=${name}`;
}

function videoVariantsFromInfo(info: RawMedia['video_info']): VideoVariant[] {
  return (info?.variants ?? [])
    .filter((v) => v.content_type === 'video/mp4' && v.url)
    .map((v) => ({
      url: v.url!,
      contentType: v.content_type!,
      bitrate: v.bitrate,
    }))
    .sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));
}

/**
 * X serves animated GIFs as looping MP4s. They ride the video-family path: poster frame
 * for vision (`media_url_https` sized like a photo), optional `video_info` variants when
 * present. Never treat a GIF as a still photo URL for description.
 */
export function extractMediaFromEntities(entities: unknown[], postHasText = true): MediaItem[] {
  const items: MediaItem[] = [];

  for (const raw of entities) {
    const media = raw as RawMedia;
    const type = media.type ?? 'photo';
    const baseUrl = media.media_url_https;
    if (!baseUrl) continue;

    const altText = parseAltText(media.ext_alt_text);
    const sizes = media.sizes;
    const large = sizes?.large;

    if (type === 'photo') {
      items.push({
        type: 'photo',
        url: buildImageUrl(baseUrl, sizes, postHasText),
        altText,
        width: large?.w,
        height: large?.h,
      });
    } else if (type === 'video' || type === 'animated_gif') {
      items.push({
        type: type === 'animated_gif' ? 'animated_gif' : 'video',
        // Poster / thumb — same pbs sizing heuristic as photos; used for vision only.
        url: buildImageUrl(baseUrl, sizes, postHasText),
        altText,
        width: large?.w,
        height: large?.h,
        videoVariants: videoVariantsFromInfo(media.video_info),
      });
    }
  }

  return items;
}

/** True when a pbs poster URL is from X's GIF pipeline (`tweet_video_thumb`). */
export function isGifPosterUrl(url: string): boolean {
  return /tweet_video_thumb/i.test(url);
}

/** X allows up to 4 photos; describe at most that many in one comprehend pass. */
export const MAX_DESCRIBE_MEDIA = 4;

/** Explicit unavailability — never silently omit media from the compose prompt (§7.4). */
export const MEDIA_UNREADABLE =
  'Media is present on this post but could not be described.';

export function isVisualMedia(item: MediaItem): boolean {
  return item.type === 'photo' || item.type === 'video' || item.type === 'animated_gif';
}

export function selectMediaForDescription(media: MediaItem[]): MediaItem[] {
  return media.filter(isVisualMedia).slice(0, MAX_DESCRIBE_MEDIA);
}

export function visionPromptForMedia(item: MediaItem): string {
  if (item.type === 'animated_gif') {
    return (
      'This is an animated GIF (looping motion). Describe the key subject and implied motion ' +
      'in one sentence for reply context. Output plain text only.'
    );
  }
  if (item.type === 'video') {
    return 'Describe this video thumbnail in one sentence for reply context. Output plain text only.';
  }
  return 'Describe this image in one sentence for reply context. Output plain text only.';
}

export function fallbackDescriptionForMedia(item: MediaItem): string {
  if (item.type === 'animated_gif') {
    return 'Animated GIF (poster frame only; motion not extracted)';
  }
  if (item.type === 'video') return 'Video post (poster frame only)';
  return MEDIA_UNREADABLE;
}

/** Join per-item descriptions; state partial view when not all media were covered. */
export function combineMediaDescriptions(
  descriptions: Array<{ index: number; text: string }>,
  totalMedia: number,
): string {
  const usable = descriptions.filter((d) => d.text.trim());
  if (usable.length === 0) return '';
  if (usable.length === 1 && totalMedia <= 1) return usable[0]!.text.trim();

  const lines = usable.map((d) => `Media ${d.index + 1}: ${d.text.trim()}`);
  if (usable.length < totalMedia) {
    lines.push(`(Partial view: described ${usable.length} of ${totalMedia} media items.)`);
  }
  return lines.join('\n');
}

/** Pick lowest-bitrate MP4 for poster/keyframe extraction in SW. */
export function pickLowestBitrateVariant(item: MediaItem): string | undefined {
  const variants = item.videoVariants ?? [];
  if (variants.length === 0) return item.url;
  return variants[0]?.url;
}

/** Extract media from a raw GraphQL tweet object. */
export function extractMediaFromTweet(tweet: unknown): MediaItem[] {
  const entities =
    dig<unknown[]>(tweet, 'legacy', 'extended_entities', 'media') ??
    dig<unknown[]>(tweet, 'legacy', 'entities', 'media') ??
    [];

  const text =
    dig<string>(tweet, 'note_tweet', 'note_tweet_results', 'result', 'text') ??
    dig<string>(tweet, 'legacy', 'full_text') ??
    '';

  return extractMediaFromEntities(entities, text.trim().length > 0);
}
