import { platformIdentity } from './registry';
import type { SourceIdentity } from './types';

/**
 * Browser-activity identities (docs/design/cross-pipeline-identity.md §3.2):
 * page views, bookmarks and downloads under the canonical `chromium` or
 * `firefox` system, minted here for every producer that sees a browser's own
 * records.
 *
 * Three producers describe the same Chrome visit — a Google Takeout
 * `History.json`, the profile's `History` SQLite database, and the browser
 * extension reading `chrome.history` — and before this module each hashed a
 * different spelling of (url, time) under a different system name, so nothing
 * ever converged. The datum's natural key is the same in all three: the URL
 * string the browser stored, and the browser's own visit instant.
 *
 * The id is human-readable, not a hash, so a mismatch is diagnosable in SQL:
 *
 *   visit:<unix ms>:<url>       page views (and the extension's reload /
 *                               search / form_submit, which have no importer
 *                               counterpart but share the shape)
 *   bookmark:<unix s>:<url>     saved links
 *   download:<unix ms>:<url>    downloads, keyed on the URL the bytes came
 *                               from (last hop of the redirect chain)
 *
 * TIME PRECISION IS THE CONTRACT. Each producer holds the instant at a
 * different precision — Takeout stamps Unix microseconds, the SQLite files
 * stamp microseconds (Chromium from 1601, Firefox from 1970), the WebExtension
 * history API hands out a double of milliseconds — so the key truncates to the
 * coarsest precision every producer can reach exactly: milliseconds for visits
 * and downloads. Bookmarks go to whole seconds because Takeout's
 * `Bookmarks.html` `ADD_DATE` is seconds and nothing finer exists there.
 * Truncation, never rounding: `Math.floor` on every side, so 12:00:00.999500
 * is `...999` everywhere rather than `...999` here and `...000` there.
 *
 * The browser extension (CI-Browser-Extension, `src/services/browserActivity.ts`)
 * cannot import this module and re-implements the format verbatim; its test
 * suite pins the same fixtures as `__tests__/identity.test.ts` here. Change
 * one, change both.
 *
 * `chromium` covers every Chromium-family browser — Chrome, Brave, Edge, Arc,
 * Opera. They share the History schema and Brave/Edge run the Chrome build of
 * the extension, so a per-brand system would split the very rows that should
 * meet. Same URL at the same millisecond in two different browsers on one
 * machine is the only collision, and it does not happen in practice.
 */
export type BrowserSystem = 'chromium' | 'firefox';

/**
 * Milliseconds between the Chromium/WebKit epoch (1601-01-01T00:00:00Z, the
 * Windows FILETIME epoch) and the Unix epoch. Chromium's `History` and
 * `Bookmarks` files stamp microseconds since 1601.
 */
export const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000;

/**
 * Unix milliseconds from Unix microseconds, truncated. Takeout's `time_usec`
 * and Firefox's `visit_date` / `dateAdded` are this.
 */
export function unixMsFromMicros(micros: number | null | undefined): number | undefined {
  if (typeof micros !== 'number' || !Number.isFinite(micros) || micros <= 0) {
    return undefined;
  }

  return Math.floor(micros / 1000);
}

/**
 * Unix milliseconds from Chromium microseconds-since-1601, truncated. The
 * offset is a whole number of milliseconds, so truncating first and then
 * shifting is exactly `floor(unix_micros / 1000)`.
 *
 * TAKES A BIGINT OR THE RAW STRING, NOT A NUMBER, WHEREVER THE SOURCE HAS ONE.
 * Present-day Chromium stamps are ~1.34e16, above 2^53, so a JS number has
 * already lost the last microsecond by the time it gets here — and a visit at
 * `...999999` reads back as `...000000`, one millisecond late, a different
 * key from the one Takeout mints for the same visit. better-sqlite3 hands the
 * exact integer over with `.safeIntegers(true)`; the Bookmarks JSON carries
 * `date_added` as a decimal string. A number is accepted for callers that
 * genuinely have nothing better, with the precision they have.
 */
export function unixMsFromChromiumMicros(
  micros: number | string | bigint | null | undefined,
): number | undefined {
  let exact: bigint;
  if (typeof micros === 'bigint') {
    exact = micros;
  } else if (typeof micros === 'string') {
    const digits = micros.trim();
    if (!/^\d+$/.test(digits)) {
      return undefined;
    }

    exact = BigInt(digits);
  } else if (typeof micros === 'number' && Number.isFinite(micros) && micros > 0) {
    exact = BigInt(Math.floor(micros));
  } else {
    return undefined;
  }

  if (exact <= 0n) {
    return undefined;
  }

  // BigInt division truncates toward zero, which is floor for a positive value.
  const ms = Number(exact / 1000n) - CHROMIUM_EPOCH_OFFSET_MS;

  return ms > 0 ? ms : undefined;
}

/**
 * Unix milliseconds from the WebExtension history API's `visitTime` /
 * `lastVisitTime` (a double of milliseconds since the Unix epoch, carrying the
 * sub-millisecond fraction). Truncated, same as the microsecond paths.
 */
export function unixMsFromApiMillis(millis: number | null | undefined): number | undefined {
  if (typeof millis !== 'number' || !Number.isFinite(millis) || millis <= 0) {
    return undefined;
  }

  return Math.floor(millis);
}

/** An undated record keys on `0`: the row is still unique per URL, and honest. */
function stamp(unixMs: number | undefined): string {
  return String(unixMs ?? 0);
}

/** One page view: `(system, visit:<unix ms>:<url>)`. */
export function browserVisitIdentity(
  system: BrowserSystem,
  url: string,
  unixMs: number | undefined,
): SourceIdentity {
  return platformIdentity(system, 'visit', stamp(unixMs), url);
}

/**
 * One saved link: `(system, bookmark:<unix s>:<url>)`. Takes milliseconds like
 * the others and truncates to seconds itself, so no caller has to know that
 * bookmarks are the coarse one.
 */
export function browserBookmarkIdentity(
  system: BrowserSystem,
  url: string,
  unixMs: number | undefined,
): SourceIdentity {
  return platformIdentity(
    system,
    'bookmark',
    unixMs === undefined ? '0' : String(Math.floor(unixMs / 1000)),
    url,
  );
}

/** One download: `(system, download:<unix ms>:<url>)`, url = final source URL. */
export function browserDownloadIdentity(
  system: BrowserSystem,
  url: string,
  unixMs: number | undefined,
): SourceIdentity {
  return platformIdentity(system, 'download', stamp(unixMs), url);
}
