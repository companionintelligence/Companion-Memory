import { applyHostAlias, matchProvider, matchProviderUri, SHORTENERS } from './providers';
import { isTrackingParam } from './tracking';
import type { CanonicalUrl } from './types';

/**
 * Canonicalise a URL into a single stable identity (design §4.2).
 *
 * Returns `null` when the input yields no usable URL identity — unparseable,
 * a non-web scheme, or a shortener whose target is unknowable without a network
 * fetch. `null` is not an error: the caller falls back to a lower identity rung.
 *
 * The function is idempotent: `canonicalizeUrl(canonicalizeUrl(u).canonical)`
 * produces the same canonical form, which is asserted as a property test.
 */
export function canonicalizeUrl(raw: string | null | undefined): CanonicalUrl | null {
  const trimmed = raw?.trim();

  if (!trimmed) {
    return null;
  }

  // Step 0: provider URI schemes (spotify:track:…) resolve to the same identity
  // as their web URL, so they must be matched before the http/https gate.
  const uriMatch = matchProviderUri(trimmed);

  if (uriMatch) {
    return {
      canonical: uriMatch.canonical,
      host: new URL(uriMatch.canonical).host,
      provider: uriMatch.provider,
      providerRef: uriMatch.providerRef,
    };
  }

  const parsed = parseUrl(trimmed);

  if (!parsed) {
    return null;
  }

  // Step 2: http and https are one identity; everything else (mailto:, file:,
  // javascript:, data:) has no URL identity here.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  // Step 3: host normalisation. `URL` already lowercases and punycodes.
  let host = parsed.hostname.replace(/\.$/, '');

  if (host.startsWith('www.')) {
    host = host.slice(4);
  }

  host = applyHostAlias(host);

  if (!host) {
    return null;
  }

  // Step 6: a recognised provider is rebuilt from its id alone; all query is
  // discarded. This is what collapses the youtu.be / watch?v= / m. / music.
  // spellings into one row.
  const provider = matchProvider(host, parsed.pathname, parsed.searchParams);

  if (provider) {
    return {
      canonical: provider.canonical,
      host,
      provider: provider.provider,
      providerRef: provider.providerRef,
    };
  }

  // Shorteners are checked only after provider rules, so youtu.be (resolvable
  // offline) is a provider and bit.ly (not) is a dead end.
  if (SHORTENERS.has(host)) {
    return null;
  }

  const path = normalizePath(parsed.pathname);
  const query = normalizeQuery(parsed.searchParams, host);
  // Step 4: the default port is already dropped by `URL`; a non-default one is
  // part of the identity and is preserved.
  const port = parsed.port ? `:${parsed.port}` : '';
  // Step 5: fragments are dropped, except a hashbang, which is a path-bearing
  // route on legacy SPAs rather than an in-page anchor.
  const hashbang = parsed.hash.startsWith('#!') ? parsed.hash : '';

  return {
    canonical: `https://${host}${port}${path}${query}${hashbang}`,
    host,
  };
}

function parseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    // A bare `example.com/x` is a URL a human would recognise; retry once.
    try {
      return new URL(`https://${input}`);
    } catch {
      return null;
    }
  }
}

/** Uppercase the hex digits of percent-escapes: `%2f` and `%2F` are one byte. */
function upperHexEscapes(value: string): string {
  return value.replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase());
}

/**
 * Percent-decode the RFC 3986 unreserved set, which must never be escaped, then
 * normalise the case of whatever escapes remain.
 */
function decodeUnreserved(value: string): string {
  return upperHexEscapes(
    value.replace(/%[0-9a-fA-F]{2}/g, (escape) => {
      const char = String.fromCharCode(parseInt(escape.slice(1), 16));

      return /[A-Za-z0-9\-._~]/.test(char) ? char : escape;
    }),
  );
}

function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  const resolved: string[] = [];

  for (const segment of collapsed.split('/')) {
    if (segment === '.' || segment === '') {
      continue;
    }

    if (segment === '..') {
      resolved.pop();
      continue;
    }

    resolved.push(decodeUnreserved(segment));
  }

  // Empty segments were filtered above, so any trailing slash is already gone
  // and the root path degenerates to `/` on its own.
  return `/${resolved.join('/')}`;
}

/** `encodeURIComponent` with normalised escape case. */
function encodeComponent(value: string): string {
  return upperHexEscapes(encodeURIComponent(value));
}

function normalizeQuery(params: URLSearchParams, host: string): string {
  const kept: Array<[string, string]> = [];

  for (const [name, value] of params) {
    if (!isTrackingParam(name, value, host)) {
      kept.push([name, value]);
    }
  }

  if (kept.length === 0) {
    return '';
  }

  // Sort by name then value so parameter order stops being identity-bearing.
  kept.sort(([aName, aValue], [bName, bValue]) =>
    aName === bName ? compareBytes(aValue, bValue) : compareBytes(aName, bName),
  );

  return `?${kept.map(([name, value]) => `${encodeComponent(name)}=${encodeComponent(value)}`).join('&')}`;
}

function compareBytes(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}
