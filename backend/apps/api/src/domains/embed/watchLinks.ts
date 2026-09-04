/**
 * Streaming providers' own catalogue pages for a work, as recorded on Wikidata.
 *
 * A streaming export carries a title and nothing else — no id, no URL — so the
 * only way back to `hulu.com` is through the work's Wikidata item, which
 * (for a fair share of catalogue titles) records the provider's id:
 *
 *   P6467 Hulu series ID        https://www.hulu.com/series/<uuid>
 *   P6466 Hulu movie ID         https://www.hulu.com/movie/<uuid>
 *   P1874 Netflix ID            https://www.netflix.com/title/<digits>
 *   P8055 Amazon Prime Video ID https://www.amazon.com/gp/video/detail/<asin>
 *
 * These are the work's pages (the show, the film), not per-episode watch
 * links — Wikidata does not carry those. None of these players can be
 * embedded, so the link is an "open on Hulu" target, not a player source.
 *
 * The unfurl cache row is per WORK and shared by every source that resolved
 * to it, so the resolver stores every provider's link in the payload
 * (`watch_links`) and the per-row read (`ContentResolver.unfurl`) picks the
 * one matching the row's `source_system`.
 */

/** Keyed by the importer's `source_system`. */
export interface WatchLinks {
  hulu?: string;
  netflix?: string;
  prime_video?: string;
}

export const WATCH_LINK_SITE_NAMES: Readonly<Record<keyof WatchLinks, string>> = {
  hulu: 'Hulu',
  netflix: 'Netflix',
  prime_video: 'Prime Video',
};

/** Wikidata's own format constraints (P1793) for each id, so a mistyped value never becomes a URL. */
const HULU_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NETFLIX_ID = /^\d{6,8}$/;
const PRIME_VIDEO_ID = /^B[0-9A-Z]{9}$/;

export interface ProviderIds {
  huluSeries?: string;
  huluMovie?: string;
  netflix?: string;
  primeVideo?: string;
}

/** The provider pages a Wikidata item's ids resolve to; undefined when it has none. */
export function watchLinksFor(ids: ProviderIds): WatchLinks | undefined {
  const links: WatchLinks = {};

  // A work is a series or a film; an item carrying both ids is a data error
  // and the series page is the safer landing.
  if (ids.huluSeries && HULU_ID.test(ids.huluSeries)) {
    links.hulu = `https://www.hulu.com/series/${ids.huluSeries}`;
  } else if (ids.huluMovie && HULU_ID.test(ids.huluMovie)) {
    links.hulu = `https://www.hulu.com/movie/${ids.huluMovie}`;
  }

  if (ids.netflix && NETFLIX_ID.test(ids.netflix)) {
    links.netflix = `https://www.netflix.com/title/${ids.netflix}`;
  }

  if (ids.primeVideo && PRIME_VIDEO_ID.test(ids.primeVideo)) {
    links.prime_video = `https://www.amazon.com/gp/video/detail/${ids.primeVideo}`;
  }

  return Object.keys(links).length ? links : undefined;
}

/**
 * The provider page for THIS row's source, out of a cached unfurl payload.
 * Null when the row's source is not a streaming provider or Wikidata knows no
 * id for it there — the caller then keeps the Wikipedia article as the page.
 */
export function watchLinkFor(
  sourceSystem: string | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): { url: string; siteName: string } | null {
  if (!sourceSystem || !(sourceSystem in WATCH_LINK_SITE_NAMES)) {
    return null;
  }

  const links = payload?.watch_links;
  if (!links || typeof links !== 'object') {
    return null;
  }

  const url = (links as Record<string, unknown>)[sourceSystem];
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    return null;
  }

  return { url, siteName: WATCH_LINK_SITE_NAMES[sourceSystem as keyof WatchLinks] };
}
