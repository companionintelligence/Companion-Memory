/**
 * Provider-aware URL rules (design §4.2, step 6).
 *
 * For a recognised provider the canonical form is *reconstructed from the
 * extracted id alone* and all query is discarded. That is what makes
 * `youtu.be/X?t=30`, `youtube.com/watch?v=X&list=PL…` and
 * `music.youtube.com/watch?v=X&si=…` one identity instead of three.
 *
 * Adding a provider: extend {@link PROVIDER_RULES} and pin every URL shape you
 * claim to support in `fixtures/identity-fixtures.json`. Rules that are not
 * fixture-pinned are assumed wrong.
 */

/**
 * Host rewrites applied before provider matching. An explicit map, never a
 * blanket leading-label strip — stripping `m.` would rewrite
 * `m.media-amazon.com`, a real and distinct image host.
 */
export const HOST_ALIASES: Readonly<Record<string, string>> = {
  'm.youtube.com': 'youtube.com',
  'music.youtube.com': 'youtube.com',
  'youtube-nocookie.com': 'youtube.com',
  'm.facebook.com': 'facebook.com',
  'mobile.facebook.com': 'facebook.com',
  'web.facebook.com': 'facebook.com',
  // A rename, not a mirror: twitter.com and x.com are the same object space.
  'twitter.com': 'x.com',
  'mobile.twitter.com': 'x.com',
  'm.twitter.com': 'x.com',
  'play.spotify.com': 'open.spotify.com',
  'player.vimeo.com': 'vimeo.com',
};

/**
 * Wikipedia publishes a `.m.` mobile mirror per language, so an explicit
 * per-language map is impractical. This is a targeted pattern, not a general
 * subdomain strip.
 */
const WIKIPEDIA_MOBILE = /^([a-z]{2,3}(?:-[a-z]+)?)\.m\.wikipedia\.org$/;

export function applyHostAlias(host: string): string {
  const mapped = HOST_ALIASES[host];

  if (mapped) {
    return mapped;
  }

  const wikipedia = WIKIPEDIA_MOBILE.exec(host);

  if (wikipedia) {
    return `${wikipedia[1]}.wikipedia.org`;
  }

  return host;
}

/**
 * URL shorteners. These resolve to no `url` identity at all — the object falls
 * back to its `nat` rung.
 *
 * Contract: no resolver may be built for these until an egress allowlist plus an
 * RFC1918 / link-local / `100.64.0.0/10` deny list ships (design §6, SSRF). A
 * shortener expander is a server-side fetch of an attacker-chooseable URL, which
 * is the exact shape of an SSRF primitive.
 */
export const SHORTENERS: ReadonlySet<string> = new Set([
  'bit.ly',
  't.co',
  'tinyurl.com',
  'lnkd.in',
  'amzn.to',
  'goo.gl',
  'ow.ly',
  'buff.ly',
  'dlvr.it',
  'ift.tt',
  'trib.al',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  't.ly',
  'is.gd',
  'v.gd',
  'rb.gy',
  'tiny.cc',
  'shr.lc',
]);

export interface ProviderMatch {
  provider: string;
  providerRef: string;
  canonical: string;
}

/** Conservative id charsets — a too-permissive match silently mints junk ids. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const YOUTUBE_LIST_ID = /^[A-Za-z0-9_-]{2,64}$/;
const YOUTUBE_CHANNEL_ID = /^[A-Za-z0-9_-]{6,64}$/;
/** Live ids are 22 base62 chars; the range is widened so pinned fixtures and
 *  any legacy short form still resolve rather than silently falling through. */
const SPOTIFY_ID = /^[A-Za-z0-9]{10,32}$/;
const SPOTIFY_TYPES = new Set(['track', 'album', 'artist', 'playlist', 'episode', 'show']);
const DIGITS = /^\d{1,20}$/;
/** `/intl-de/track/…` and the like. */
const SPOTIFY_INTL = /^intl-[a-z]{2,3}$/;

function segments(pathname: string): string[] {
  return pathname.split('/').filter((part) => part.length > 0);
}

function matchYouTube(host: string, pathname: string, query: URLSearchParams): ProviderMatch | null {
  const parts = segments(pathname);

  const video = (id: string): ProviderMatch => ({
    provider: 'youtube',
    providerRef: `youtube:video:${id}`,
    canonical: `https://youtube.com/watch?v=${id}`,
  });

  if (host === 'youtu.be') {
    const id = parts[0];

    return id && YOUTUBE_ID.test(id) ? video(id) : null;
  }

  if (host !== 'youtube.com') {
    return null;
  }

  if (parts[0] === 'watch') {
    const id = query.get('v');

    return id && YOUTUBE_ID.test(id) ? video(id) : null;
  }

  if (parts.length === 2 && ['shorts', 'embed', 'live', 'v'].includes(parts[0])) {
    return YOUTUBE_ID.test(parts[1]) ? video(parts[1]) : null;
  }

  if (parts[0] === 'playlist') {
    const list = query.get('list');

    return list && YOUTUBE_LIST_ID.test(list)
      ? {
          provider: 'youtube',
          providerRef: `youtube:playlist:${list}`,
          canonical: `https://youtube.com/playlist?list=${list}`,
        }
      : null;
  }

  if (parts.length === 2 && parts[0] === 'channel' && YOUTUBE_CHANNEL_ID.test(parts[1])) {
    return {
      provider: 'youtube',
      providerRef: `youtube:channel:${parts[1]}`,
      canonical: `https://youtube.com/channel/${parts[1]}`,
    };
  }

  return null;
}

function matchSpotify(host: string, pathname: string): ProviderMatch | null {
  if (host !== 'open.spotify.com') {
    return null;
  }

  const parts = segments(pathname);
  const withoutIntl = parts[0] && SPOTIFY_INTL.test(parts[0]) ? parts.slice(1) : parts;
  const [type, id] = withoutIntl;

  if (!type || !id || !SPOTIFY_TYPES.has(type) || !SPOTIFY_ID.test(id)) {
    return null;
  }

  return {
    provider: 'spotify',
    providerRef: `spotify:${type}:${id}`,
    canonical: `https://open.spotify.com/${type}/${id}`,
  };
}

function matchX(host: string, pathname: string): ProviderMatch | null {
  if (host !== 'x.com') {
    return null;
  }

  const parts = segments(pathname);
  const statusAt = parts.indexOf('status');

  // `/<user>/status/<id>` and `/i/web/status/<id>` both carry the tweet id in
  // the segment after `status`. The username is discarded: it is mutable and
  // any username resolves the same tweet.
  if (statusAt === -1) {
    return null;
  }

  const id = parts[statusAt + 1];

  return id && DIGITS.test(id)
    ? {
        provider: 'x',
        providerRef: `x:tweet:${id}`,
        canonical: `https://x.com/i/status/${id}`,
      }
    : null;
}

function matchVimeo(host: string, pathname: string): ProviderMatch | null {
  if (host !== 'vimeo.com') {
    return null;
  }

  const parts = segments(pathname);
  const id = parts[0] === 'video' ? parts[1] : parts[0];

  return id && DIGITS.test(id)
    ? {
        provider: 'vimeo',
        providerRef: `vimeo:video:${id}`,
        canonical: `https://vimeo.com/${id}`,
      }
    : null;
}

export const PROVIDER_RULES: ReadonlyArray<
  (host: string, pathname: string, query: URLSearchParams) => ProviderMatch | null
> = [matchYouTube, matchSpotify, matchX, matchVimeo];

export function matchProvider(
  host: string,
  pathname: string,
  query: URLSearchParams,
): ProviderMatch | null {
  for (const rule of PROVIDER_RULES) {
    const match = rule(host, pathname, query);

    if (match) {
      return match;
    }
  }

  return null;
}

/**
 * Non-http provider URI schemes, matched before the http/https gate so a native
 * handle and its web URL collapse to one identity.
 */
export function matchProviderUri(raw: string): ProviderMatch | null {
  const spotify = /^spotify:([a-z]+):([A-Za-z0-9]{10,32})$/.exec(raw.trim());

  if (spotify && SPOTIFY_TYPES.has(spotify[1])) {
    return {
      provider: 'spotify',
      providerRef: `spotify:${spotify[1]}:${spotify[2]}`,
      canonical: `https://open.spotify.com/${spotify[1]}/${spotify[2]}`,
    };
  }

  return null;
}
