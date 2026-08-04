/**
 * Shared helpers for the four YouTube transforms.
 *
 * All four write `ci.content` rows whose `url` is a watch/channel/playlist page
 * rather than a media file. The poster and runtime the provider already returns
 * were parsed into local interfaces and discarded; these helpers normalise them
 * so they can be persisted once and reused by the embed player without a second
 * API call. See `docs/prd/unified-content-identity-lifecycle-embeds.md` §6.
 */

/** `source_system` for every YouTube-derived `ci.content` row. */
export const YOUTUBE_SOURCE_SYSTEM = 'youtube';

export interface YouTubeThumbnail {
  url?: string;
  width?: number;
  height?: number;
}

export interface YouTubeThumbnailSet {
  default?: YouTubeThumbnail;
  medium?: YouTubeThumbnail;
  high?: YouTubeThumbnail;
  standard?: YouTubeThumbnail;
  maxres?: YouTubeThumbnail;
}

export interface NormalizedThumbnail {
  url: string;
  width?: number;
  height?: number;
}

/**
 * Highest-resolution thumbnail the provider actually returned, or null.
 *
 * Preferring `maxres` here is safe precisely because it is read from the API
 * response: the key is absent when no such rendition exists. That is a different
 * operation from *constructing* `…/maxresdefault.jpg` from a video id, which
 * 404s for every sub-720p upload — never do that.
 */
export function bestThumbnail(thumbnails?: YouTubeThumbnailSet | null): NormalizedThumbnail | null {
  if (!thumbnails) {
    return null;
  }

  const ordered = [
    thumbnails.maxres,
    thumbnails.standard,
    thumbnails.high,
    thumbnails.medium,
    thumbnails.default,
  ];

  for (const candidate of ordered) {
    const url = candidate?.url?.trim();

    if (url) {
      return {
        url,
        ...(typeof candidate?.width === 'number' ? { width: candidate.width } : {}),
        ...(typeof candidate?.height === 'number' ? { height: candidate.height } : {}),
      };
    }
  }

  return null;
}

/** `PnYnMnDTnHnMnS` — the subset YouTube emits for `contentDetails.duration`. */
const ISO8601_DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const SECONDS_PER = {
  year: 31_536_000,
  month: 2_592_000,
  week: 604_800,
  day: 86_400,
  hour: 3_600,
  minute: 60,
} as const;

/**
 * ISO 8601 duration to whole seconds, or null when absent or unparseable.
 *
 * Years and months are nominal (365d / 30d). YouTube runtimes never reach either
 * unit, so the approximation is unreachable in practice — it exists only so a
 * malformed value degrades to a number rather than throwing.
 */
export function parseIso8601DurationSeconds(duration?: string | null): number | null {
  const trimmed = duration?.trim();

  if (!trimmed) {
    return null;
  }

  const match = ISO8601_DURATION.exec(trimmed);

  if (!match) {
    return null;
  }

  const [, years, months, weeks, days, hours, minutes, seconds] = match;

  // A bare `P`/`PT` matches the pattern but carries no components.
  if (![years, months, weeks, days, hours, minutes, seconds].some((part) => part !== undefined)) {
    return null;
  }

  const total =
    Number(years ?? 0) * SECONDS_PER.year +
    Number(months ?? 0) * SECONDS_PER.month +
    Number(weeks ?? 0) * SECONDS_PER.week +
    Number(days ?? 0) * SECONDS_PER.day +
    Number(hours ?? 0) * SECONDS_PER.hour +
    Number(minutes ?? 0) * SECONDS_PER.minute +
    Number(seconds ?? 0);

  return Math.round(total);
}
