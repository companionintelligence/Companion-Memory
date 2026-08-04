/**
 * Shared YouTube media helpers for the four YouTube transforms.
 *
 * The YouTube API already returns everything needed to render a real thumbnail
 * and a duration, and every transform was parsing `snippet.thumbnails` into its
 * local interface and then discarding it — so a liked video landed in ci.content
 * with a watch-page URL, `mimetype: 'video/youtube'`, and no poster at all.
 *
 * `provider` / `providerRef` are written alongside the thumbnail so a structural
 * player can be derived later without a second API call or any network fetch:
 * `youtube:video:<id>` is a pure function of the id, and the embed URL is a pure
 * function of that.
 */

/** Thumbnail set as returned by videos.list / playlistItems.list / subscriptions.list. */
export interface YouTubeThumbnails {
  default?: { url?: string };
  medium?: { url?: string };
  high?: { url?: string };
  standard?: { url?: string };
  maxres?: { url?: string };
}

export const YOUTUBE_PROVIDER = 'youtube';

/**
 * Best available thumbnail URL, largest first.
 *
 * `maxres` is preferred when the API actually returns it — but it is NOT
 * synthesised from the video id, because `maxresdefault.jpg` 404s for any upload
 * below 720p and there is no way to check without a network request. Only URLs
 * the API itself reported are used.
 */
export function pickThumbnailUrl(thumbnails?: YouTubeThumbnails): string | undefined {
  if (!thumbnails) {
    return undefined;
  }

  return (
    thumbnails.maxres?.url ??
    thumbnails.standard?.url ??
    thumbnails.high?.url ??
    thumbnails.medium?.url ??
    thumbnails.default?.url ??
    undefined
  );
}

/** Stable provider reference for a video: `youtube:video:<id>`. */
export function videoProviderRef(videoId: string): string {
  return `${YOUTUBE_PROVIDER}:video:${videoId}`;
}

/** Stable provider reference for a channel: `youtube:channel:<id>`. */
export function channelProviderRef(channelId: string): string {
  return `${YOUTUBE_PROVIDER}:channel:${channelId}`;
}

/** Stable provider reference for a playlist: `youtube:playlist:<id>`. */
export function playlistProviderRef(playlistId: string): string {
  return `${YOUTUBE_PROVIDER}:playlist:${playlistId}`;
}

const ISO_DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Parses an ISO-8601 duration (`PT4M13S`, `PT1H2M3S`, `PT0S`) to whole seconds.
 *
 * Returns `undefined` rather than 0 for anything unparseable, so a missing
 * duration stays distinguishable from a genuinely zero-length one. YouTube
 * reports `P0D` for live streams that never ended — that parses to 0, which is
 * correct: no known duration yet.
 */
export function parseIsoDurationSeconds(iso?: string | null): number | undefined {
  if (!iso) {
    return undefined;
  }

  const match = ISO_DURATION.exec(iso.trim());
  if (!match) {
    return undefined;
  }

  const [, weeks, days, hours, minutes, seconds] = match;

  // An all-empty match ("P", "PT") is not a duration.
  if (!weeks && !days && !hours && !minutes && !seconds) {
    return undefined;
  }

  const total =
    Number(weeks ?? 0) * 604800 +
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);

  return Math.round(total);
}

/**
 * The embed-facing half of a YouTube content row's `source_data`.
 *
 * Kept in one place so all four transforms agree on key names — the embed track
 * reads these, and a per-transform spelling would silently render half the
 * corpus unplayable.
 */
export function youtubeEmbedSourceData({
  providerRef,
  thumbnails,
  durationIso,
}: {
  providerRef: string;
  thumbnails?: YouTubeThumbnails;
  durationIso?: string | null;
}): Record<string, unknown> {
  const thumbnailUrl = pickThumbnailUrl(thumbnails);
  const durationSeconds = parseIsoDurationSeconds(durationIso);

  return {
    provider: YOUTUBE_PROVIDER,
    providerRef,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(thumbnails ? { thumbnails } : {}),
    ...(durationIso ? { durationIso } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}
