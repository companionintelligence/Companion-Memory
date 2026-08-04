/**
 * URL canonicalization — the foundation of URL-based object identity.
 *
 * Today there is no URL identity anywhere in this repo: no index on
 * `ci.content.url` or `source_url`, and the only `canonicalize` in the tree is
 * GeocodeService's free-text address normalizer. So `youtu.be/X`,
 * `youtube.com/watch?v=X&utm_source=newsletter` and `m.youtube.com/watch?v=X`
 * are three unrelated rows for one video, and every re-share of a link with a
 * fresh tracking parameter mints another.
 *
 * Two-stage algorithm:
 *
 *   1. PROVIDER RULES (allowlist). For a recognized host the canonical form is
 *      REBUILT FROM THE EXTRACTED ID ALONE and all query is discarded. This is
 *      what collapses `youtu.be/X?t=30` and `watch?v=X&list=PL&index=3` — a
 *      generic parameter-stripper cannot, because it has no way to know `t` and
 *      `list` are not identity-bearing while `v` is.
 *
 *   2. GENERIC (everything else). Conservative: strip only known-tracking
 *      parameters, sort the rest, normalize the path. Unrecognized parameters
 *      are KEPT, because on an unknown host any parameter may be identity —
 *      `?ref=hn` is a tracking tag on some sites and a permalink on others.
 *
 * Shorteners return null rather than being resolved. Resolving one requires a
 * network fetch of an attacker-supplied URL, which is an SSRF sink; no resolver
 * may be added until an egress allowlist with an RFC1918 / link-local /
 * 100.64.0.0/10 deny list ships. (100.64/10 matters here specifically — this
 * appliance is routinely reached over a Tailscale tailnet.)
 */

export interface CanonicalUrl {
  /** Canonical, human-readable URL. Stable across spellings of the same resource. */
  canonical: string;
  /** Lowercased, punycode host of the canonical URL. */
  host: string;
  /** Extractor name when a provider rule matched: 'youtube', 'spotify', … */
  provider?: string;
  /** Stable provider reference, e.g. `youtube:video:dQw4w9WgXcQ`. */
  providerRef?: string;
}

/**
 * Hosts whose canonical form cannot be derived without dereferencing them.
 * Returning null means "emit no `url` identity" — the caller falls back to a
 * natural key. NEVER resolve these with a network request; see the header.
 */
const SHORTENERS = new Set([
  'bit.ly',
  't.co',
  'tinyurl.com',
  'goo.gl',
  'lnkd.in',
  'amzn.to',
  'ow.ly',
  'buff.ly',
  'dlvr.it',
  'ift.tt',
  'trib.al',
  'rebrand.ly',
  'is.gd',
  'shorturl.at',
  // NOTE: youtu.be is deliberately NOT here. It looks like a shortener but the
  // video id is structurally present in the path, so it canonicalizes offline.
]);

/**
 * Mobile / regional mirrors that serve the same resource as their canonical
 * host. An EXPLICIT map only — a blanket "strip a leading `m.` label" would
 * rewrite `m.media-amazon.com` (a real, distinct image CDN host) and silently
 * corrupt identity for every Amazon image.
 */
const MOBILE_MIRRORS: Record<string, string> = {
  'm.youtube.com': 'youtube.com',
  'music.youtube.com': 'youtube.com',
  'm.facebook.com': 'facebook.com',
  'mobile.facebook.com': 'facebook.com',
  'mobile.twitter.com': 'x.com',
  'm.twitter.com': 'x.com',
  'twitter.com': 'x.com',
};

/** Tracking parameters that are never identity-bearing, on any host. */
const GLOBAL_TRACKING = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'msclkid',
  'twclid',
  'ttclid',
  'yclid',
  'igshid',
  'igsh',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  'mkt_tok',
  'vero_id',
  'vero_conv',
  'oly_anon_id',
  'oly_enc_id',
  'hsCtaTracking',
  '__hstc',
  '__hssc',
  '__hsfp',
  's_kwcid',
  'ef_id',
  'sc_cid',
  'ncid',
  'mibextid',
]);

/**
 * Parameters that are tracking ONLY on specific hosts. `ref` is the canonical
 * example: tracking on x.com and reddit.com, but a genuine permalink component
 * on plenty of blogs and docs sites — so it is never stripped globally.
 */
const HOST_SCOPED_TRACKING: Record<string, string[]> = {
  'x.com': ['ref', 'ref_src', 'ref_url', 's', 't'],
  'reddit.com': ['ref', 'ref_source', 'share_id', 'utm_name'],
  'www.reddit.com': ['ref', 'ref_source', 'share_id', 'utm_name'],
  'linkedin.com': ['source', 'trk', 'trkInfo', 'originalSubdomain'],
  'aliexpress.com': ['spm', 'scm', 'pdp_ext_f'],
  'amazon.com': ['tag', 'linkCode', 'creative', 'creativeASIN', 'ascsubtag', 'th', 'psc'],
};

interface ProviderRule {
  name: string;
  /** Hosts this rule applies to (already mirror-normalized). */
  hosts: string[];
  /**
   * Returns the extracted reference kind + id, or null when the path is not a
   * recognized shape for this provider (in which case the generic path runs).
   */
  extract: (path: string, params: URLSearchParams) => { kind: string; id: string } | null;
  /** Rebuilds the canonical URL from the extracted id ALONE. */
  rebuild: (kind: string, id: string) => string;
}

/** Path segments with empty parts removed: '/watch/' -> ['watch']. */
function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

const PROVIDER_RULES: ProviderRule[] = [
  {
    name: 'youtube',
    hosts: ['youtube.com', 'youtu.be'],
    extract: (path, params) => {
      const seg = segments(path);

      // youtu.be/<id>
      if (seg.length === 1 && seg[0] !== 'watch') {
        return { kind: 'video', id: seg[0] };
      }

      // /watch?v=<id>
      const v = params.get('v');
      if (v) {
        return { kind: 'video', id: v };
      }

      // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
      if (seg.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(seg[0])) {
        return { kind: 'video', id: seg[1] };
      }

      // /playlist?list=<id>
      const list = params.get('list');
      if (seg[0] === 'playlist' && list) {
        return { kind: 'playlist', id: list };
      }

      // /channel/<id>
      if (seg.length >= 2 && seg[0] === 'channel') {
        return { kind: 'channel', id: seg[1] };
      }

      return null;
    },
    rebuild: (kind, id) => {
      if (kind === 'video') {
        return `https://youtube.com/watch?v=${id}`;
      }

      if (kind === 'playlist') {
        return `https://youtube.com/playlist?list=${id}`;
      }

      return `https://youtube.com/channel/${id}`;
    },
  },
  {
    name: 'spotify',
    hosts: ['open.spotify.com', 'spotify.com', 'play.spotify.com'],
    extract: (path) => {
      // Strip an optional /intl-xx locale prefix, then <kind>/<id>.
      const seg = segments(path).filter((s) => !/^intl-[a-z]{2}$/i.test(s));
      const kinds = ['track', 'album', 'artist', 'playlist', 'episode', 'show'];
      if (seg.length >= 2 && kinds.includes(seg[0])) {
        return { kind: seg[0], id: seg[1] };
      }

      return null;
    },
    rebuild: (kind, id) => `https://open.spotify.com/${kind}/${id}`,
  },
  {
    name: 'vimeo',
    hosts: ['vimeo.com', 'player.vimeo.com'],
    extract: (path) => {
      const seg = segments(path);
      const idx = seg[0] === 'video' ? 1 : 0;
      const id = seg[idx];
      if (id && /^\d+$/.test(id)) {
        return { kind: 'video', id };
      }

      return null;
    },
    rebuild: (_kind, id) => `https://vimeo.com/${id}`,
  },
  {
    name: 'x',
    hosts: ['x.com'],
    extract: (path) => {
      const seg = segments(path);
      // /<user>/status/<id> — the user is NOT identity: a tweet keeps its id
      // across handle changes, and the same tweet is linked under /i/ too.
      const i = seg.indexOf('status');
      if (i >= 0 && seg[i + 1] && /^\d+$/.test(seg[i + 1])) {
        return { kind: 'tweet', id: seg[i + 1] };
      }

      return null;
    },
    rebuild: (_kind, id) => `https://x.com/i/status/${id}`,
  },
  {
    name: 'soundcloud',
    hosts: ['soundcloud.com', 'm.soundcloud.com'],
    extract: (path) => {
      const seg = segments(path);
      // /<artist>/<track> is the stable permalink pair.
      if (seg.length >= 2 && seg[0] !== 'you') {
        return { kind: 'track', id: `${seg[0]}/${seg[1]}` };
      }

      return null;
    },
    rebuild: (_kind, id) => `https://soundcloud.com/${id}`,
  },
  {
    name: 'dailymotion',
    hosts: ['dailymotion.com', 'dai.ly'],
    extract: (path) => {
      const seg = segments(path);
      const idx = seg[0] === 'video' ? 1 : 0;
      const id = seg[idx];
      if (id) {
        // Trailing slug after the id is decorative: x8abcd_some-title.
        return { kind: 'video', id: id.split('_')[0] };
      }

      return null;
    },
    rebuild: (_kind, id) => `https://dailymotion.com/video/${id}`,
  },
];

/** Percent-escapes uppercased; unreserved characters decoded. */
function normalizePercentEncoding(value: string): string {
  return value.replace(/%[0-9a-fA-F]{2}/g, (match) => {
    const code = parseInt(match.slice(1), 16);
    const char = String.fromCharCode(code);
    // Unreserved per RFC 3986: ALPHA / DIGIT / '-' / '.' / '_' / '~'
    if (/[A-Za-z0-9\-._~]/.test(char)) {
      return char;
    }

    return match.toUpperCase();
  });
}

function normalizePath(pathname: string): string {
  const out: string[] = [];
  for (const seg of pathname.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }

    if (seg === '..') {
      out.pop();
      continue;
    }

    out.push(normalizePercentEncoding(seg));
  }

  let path = `/${out.join('/')}`;
  // Drop exactly one trailing slash, but never reduce the path below '/'.
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return path;
}

/**
 * Canonicalizes a URL for identity purposes.
 *
 * Returns null when the input is not a canonicalizable absolute URL (unparseable,
 * a non-http(s) scheme, or a shortener whose target is unknown). A null return
 * means "no URL identity available", not "error".
 *
 * Idempotent by construction: `canonicalizeUrl(canonicalizeUrl(u)) === canonicalizeUrl(u)`.
 */
export function canonicalizeUrl(raw: string): CanonicalUrl | null {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // A bare `example.com/x` is a common shape in scraped/imported data.
    try {
      url = new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }

  // Non-web schemes carry no web identity. `spotify:track:ID` is handled as a
  // special case first because it IS a stable provider reference.
  if (url.protocol === 'spotify:') {
    const parts = trimmed.split(':');
    if (parts.length >= 3 && parts[1] && parts[2]) {
      return {
        canonical: `https://open.spotify.com/${parts[1]}/${parts[2]}`,
        host: 'open.spotify.com',
        provider: 'spotify',
        providerRef: `spotify:${parts[1]}:${parts[2]}`,
      };
    }

    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  // http and https are ONE identity.
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) {
    host = host.slice(4);
  }

  host = MOBILE_MIRRORS[host] ?? host;

  if (SHORTENERS.has(host)) {
    return null;
  }

  const rule = PROVIDER_RULES.find((r) => r.hosts.includes(host));
  if (rule) {
    const extracted = rule.extract(url.pathname, url.searchParams);
    if (extracted) {
      const canonical = rule.rebuild(extracted.kind, extracted.id);

      return {
        canonical,
        host: new URL(canonical).hostname,
        provider: rule.name,
        providerRef: `${rule.name}:${extracted.kind}:${extracted.id}`,
      };
    }
    // Fall through to the generic path: a recognized host with an unrecognized
    // path shape is still a normalizable URL.
  }

  // --- generic path ---
  const params = new URLSearchParams(url.search);
  const hostScoped = HOST_SCOPED_TRACKING[host] ?? [];
  for (const key of [...params.keys()]) {
    if (/^utm_/i.test(key) || GLOBAL_TRACKING.has(key) || hostScoped.includes(key)) {
      params.delete(key);
    }
  }

  const sorted = [...params.entries()].sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1,
  );
  const query = sorted.map(([k, v]) => `${k}=${v}`).join('&');

  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
  const path = normalizePath(url.pathname);

  return {
    canonical: `https://${host}${port}${path}${query ? `?${query}` : ''}`,
    host,
  };
}
