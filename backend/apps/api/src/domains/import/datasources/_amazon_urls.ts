/* Public product-page URLs derived from Amazon catalog ids (ASINs).
   Amazon's exports carry ASINs but never links; the page URL is a fixed
   function of the ASIN, so a content row can get a real `url` (link-out,
   future embed/OG enrichment) without a network lookup. Prime Video is
   deliberately absent: its export carries titles only, and the
   `primevideo:title:<hash>` id is ours, not Amazon's. */

const ASIN_RE = /^[A-Z0-9]{10}$/;

/** A real 10-character catalog ASIN, or undefined for anything else. */
export function asinOrUndefined(value: string | undefined | null): string | undefined {
  const v = (value ?? '').trim().toUpperCase();

  return ASIN_RE.test(v) ? v : undefined;
}

export function audibleUrl(asin: string | undefined | null): string | undefined {
  const a = asinOrUndefined(asin);

  return a ? `https://www.audible.com/pd/${a}` : undefined;
}

export function kindleUrl(asin: string | undefined | null): string | undefined {
  const a = asinOrUndefined(asin);

  return a ? `https://www.amazon.com/dp/${a}` : undefined;
}

export function amazonMusicAlbumUrl(albumAsin: string | undefined | null): string | undefined {
  const a = asinOrUndefined(albumAsin);

  return a ? `https://music.amazon.com/albums/${a}` : undefined;
}

/** A track's page: Amazon's own share link is the album page focused on the
 *  track; a bare `/tracks/<asin>` resolves when the album isn't known. */
export function amazonMusicTrackUrl(
  trackAsin: string | undefined | null,
  albumAsin?: string | undefined | null,
): string | undefined {
  const t = asinOrUndefined(trackAsin);
  if (!t) {
    return undefined;
  }

  const album = asinOrUndefined(albumAsin);

  return album
    ? `https://music.amazon.com/albums/${album}?trackAsin=${t}`
    : `https://music.amazon.com/tracks/${t}`;
}
