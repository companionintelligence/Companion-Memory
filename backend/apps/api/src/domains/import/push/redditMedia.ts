/**
 * Which Reddit URLs are media. Shared by the importer's push mapping
 * (`redditMediaUrl` in canonical.ts) and the connection's transform
 * (etl/services/Reddit/transform/RedditRecordWriter.ts): both route a post or
 * comment to a `ci.content` row only when it carries an image or video, so
 * both must agree on what counts as one.
 *
 * Reddit's GDPR export is CSV-only — media exists solely as URLs — and the
 * API's listing objects are the same shape (a link post's `url`, a comment's
 * body markdown). Direct-media hosts, or any URL whose path ends in a media
 * extension, count; imgur PAGE links (imgur.com/abc) don't. .gifv is imgur's
 * video wrapper, hence video.
 */
const REDDIT_IMAGE_HOSTS = /^https?:\/\/(i\.redd\.it|preview\.redd\.it|i\.imgur\.com)\//i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|heic)$/i;
const REDDIT_VIDEO_HOSTS = /^https?:\/\/v\.redd\.it\//i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|gifv)$/i;

export type RedditMediaKind = 'image' | 'video';

export interface RedditMediaRef {
  url: string;
  kind: RedditMediaKind;
}

/** `image` / `video` when the URL points straight at media, else null. */
export function redditMediaKind(url: string): RedditMediaKind | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  if (REDDIT_VIDEO_HOSTS.test(url) || VIDEO_EXT.test(pathname)) {
    return 'video';
  }

  if (REDDIT_IMAGE_HOSTS.test(url) || IMAGE_EXT.test(pathname)) {
    return 'image';
  }

  return null;
}

/** The media a link post points at, or null (a self post's url is its own permalink). */
export function redditLinkMedia(url: string | null | undefined): RedditMediaRef | null {
  if (!url) {
    return null;
  }

  const kind = redditMediaKind(url);

  return kind ? { url, kind } : null;
}

/**
 * The first direct image/video link in a comment's body markdown, or null. A
 * comment has no URL field pointing at media (its URL is its own permalink),
 * so this is the only place its media can be.
 */
export function firstRedditMediaLink(body: string | null | undefined): RedditMediaRef | null {
  for (const m of (body ?? '').matchAll(/https?:\/\/[^\s)\]<>"']+/g)) {
    const url = m[0].replace(/[.,;!?]+$/, '');
    const kind = redditMediaKind(url);
    if (kind) {
      return { url, kind };
    }
  }

  return null;
}
