import crypto from 'node:crypto';

/**
 * What the streaming-service importers (netflix, hulu, disney_plus) share.
 *
 * Each used to carry its own copy of the title hash and the whitespace/case
 * fold, and disney_plus imported `Occurrences` and `composeWatchTitle` from
 * hulu — one importer depending on a sibling for a helper that belongs to
 * neither. The hashes are byte-for-byte what the copies produced, so every
 * stored `URI` stays the same.
 */

/** Whitespace-collapsed, trimmed, lower-cased: the fold every watch identity is built on. */
export function normTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Stable per-title identity for the content row: case/whitespace-insensitive
 * hash of the composed title, so every play of one episode (and every
 * re-export) lands on ONE content row while each play stays its own event.
 * sha256, not sha1, so plain Postgres can recompute the identical value when
 * legacy per-viewing rows need collapsing onto it by hand.
 */
export function titleUri(service: 'netflix' | 'hulu' | 'disney_plus', title: string): string {
  return `${service}:title:${crypto.createHash('sha256').update(normTitle(title)).digest('hex').slice(0, 16)}`;
}

/**
 * Netflix's title shape, "Series: Season N: Episode", so the services' watch
 * rows read alike. Movies and live events have no series and become the bare
 * name; a season of 0 (a news broadcast) or N/A is left out.
 */
export function composeWatchTitle(episode: string, series: string, season: string): string {
  if (!series) {
    return episode;
  }

  const parts = [series];
  if (/^[1-9]\d*$/.test(season)) {
    parts.push(`Season ${season}`);
  }

  parts.push(episode);

  return parts.join(': ');
}

/**
 * What a Hulu or Disney+ content row says it is. Both stream over MPEG-DASH,
 * so the row carries the DASH manifest type rather than the `text/plain` of
 * the title placeholder the importer writes as its body (the netflix.ts /
 * letterboxd.ts habit). It is a statement about the thing watched, not about
 * those bytes.
 */
export const WATCH_MEDIA_TYPE = 'application/dash+xml';

/**
 * Distinct, stable ids for rows that are byte-identical within one report.
 * Hulu's and Disney+'s reports both have the habit.
 */
export class Occurrences {
  private readonly seen = new Map<string, number>();

  id(base: string): string {
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);

    return n === 0 ? base : `${base}:${n}`;
  }
}
