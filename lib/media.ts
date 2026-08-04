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

    if (type === 'photo' || type === 'animated_gif') {
      items.push({
        type: type === 'animated_gif' ? 'animated_gif' : 'photo',
        url: buildImageUrl(baseUrl, sizes, postHasText),
        altText,
        width: large?.w,
        height: large?.h,
      });
    } else if (type === 'video') {
      const variants: VideoVariant[] = (media.video_info?.variants ?? [])
        .filter((v) => v.content_type === 'video/mp4' && v.url)
        .map((v) => ({
          url: v.url!,
          contentType: v.content_type!,
          bitrate: v.bitrate,
        }))
        .sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));

      items.push({
        type: 'video',
        url: baseUrl,
        altText,
        width: large?.w,
        height: large?.h,
        videoVariants: variants,
      });
    }
  }

  return items;
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
