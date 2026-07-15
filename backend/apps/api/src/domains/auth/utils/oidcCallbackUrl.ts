const CALLBACK_PATH = '/api/authenticate/oidc/callback';
const INITIATE_PATH = '/api/authenticate/oidc';

export interface OidcCallbackRequestOrigin {
  /** `x-forwarded-proto` header value, if present (set by Traefik/Cloudflare). */
  forwardedProto?: string | string[];
  /** `x-forwarded-host` header value, if present. */
  forwardedHost?: string | string[];
  /** `Host` header value. */
  host?: string;
  /** Whether the inbound connection itself is TLS (`req.secure`). */
  secure: boolean;
}

/**
 * Normalize a forwarded header to its first hop. These headers can arrive as an
 * array (multiple proxies set the same header) or a comma-separated list
 * (`https, http`); the left-most value is the one the original client connected
 * with. Using the raw value would otherwise yield an invalid `https,http://...`
 * proto or a multi-host authority.
 */
function firstForwardedValue(value?: string | string[]): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;

  return raw?.split(',')[0]?.trim() || undefined;
}

/**
 * Build the OIDC `redirect_uri` (callback) for the "Sign in with CI-Portal" flow.
 *
 * Prefers `publicBaseUrl` — the app's stable public origin injected by CI-Hub as
 * `APP_BASE_URL` (e.g. `https://ci-memory-<org>.companionintelligence.com`).
 *
 * Without it the callback is derived from whatever host the browser used to reach
 * the app. Reaching it at the local `*.localhost` route then produces a
 * `http://...localhost/...` callback that CI-Portal cannot redirect a remote
 * browser back to — which is why Portal login fails when the app is opened on its
 * local route. The request-derived form is kept as a fallback for local/dev
 * installs that have no public base URL.
 */
export function resolveOidcCallbackUrl(origin: OidcCallbackRequestOrigin, publicBaseUrl?: string): string {
  const normalizedBase = normalizePublicBaseUrl(publicBaseUrl);

  if (normalizedBase) {
    return `${normalizedBase}${CALLBACK_PATH}`;
  }

  return `${resolveRequestOrigin(origin)}${CALLBACK_PATH}`;
}

function normalizePublicBaseUrl(publicBaseUrl?: string): string | undefined {
  return publicBaseUrl?.trim().replace(/\/+$/, '') || undefined;
}

/**
 * Marker on the bounce target. A bounce that lands back here must never bounce
 * again: any residual host-shape mismatch we failed to normalize (an explicit
 * `:443`, a trailing-dot FQDN, an IPv6 spelling) would otherwise redirect the
 * browser in a loop forever — turning a recoverable sign-in failure into a total
 * outage. One hop, then give up and let the flow proceed from here.
 */
export const OIDC_ORIGIN_BOUNCE_PARAM = 'origin_bounced';

/**
 * The raw host[:port] the browser addressed, as sent. The single place that derives it,
 * so the bounce comparison and the callback fallback can never disagree about which
 * host the browser actually used.
 */
function rawRequestHost(origin: OidcCallbackRequestOrigin): string {
  return firstForwardedValue(origin.forwardedHost) || origin.host?.trim() || 'localhost';
}

/**
 * The host[:port] the browser used, canonicalised the same way `new URL().host`
 * canonicalises the public base — lower-cased, trailing dot removed, and the
 * scheme's default port dropped — so that benign spelling differences do not read
 * as a different host.
 */
function resolveRequestHost(origin: OidcCallbackRequestOrigin, scheme: string): string {
  const host = rawRequestHost(origin).toLowerCase();

  // Split off the port without tripping over an IPv6 literal's own colons.
  const portMatch = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(host);

  if (!portMatch) {
    return host;
  }

  const hostname = portMatch[1].replace(/\.$/, '');
  const port = portMatch[2];
  const isDefaultPort = (scheme === 'https:' && port === '443') || (scheme === 'http:' && port === '80');

  return port && !isDefaultPort ? `${hostname}:${port}` : hostname;
}

/**
 * The full origin the browser used. Only for the no-public-base fallback, where a
 * scheme is needed to build an absolute callback; the bounce below deliberately
 * ignores the scheme (see {@link resolveOidcOriginBounce}).
 */
function resolveRequestOrigin(origin: OidcCallbackRequestOrigin): string {
  const proto = firstForwardedValue(origin.forwardedProto) || (origin.secure ? 'https' : 'http');

  return `${proto}://${rawRequestHost(origin)}`;
}

/**
 * Where to send the browser before starting OIDC, when it reached this app on a
 * host other than `publicBaseUrl`'s — or `null` when the flow can start here.
 *
 * The state/PKCE cookies are written on whatever host the browser used, but
 * `redirect_uri` is always the public base URL (CI-Portal only accepts registered
 * redirect URIs, so it cannot be the LAN address). When the two differ — an app
 * opened at its LAN address or its `*.localhost` route, which is the default for
 * an app that is installed but not publicly exposed — CI-Portal returns the
 * browser to the public host, which holds neither cookie, and sign-in dies with
 * `invalid_state`.
 *
 * Moving the browser to the public host *first* keeps the whole flow — cookies,
 * callback, and the session it establishes — in one place.
 *
 * Compares HOST, never scheme. Cookies are keyed by host, not by scheme, so the
 * scheme is irrelevant to the bug — and comparing it would be actively dangerous:
 * the ci-memory gateway sets `X-Forwarded-Proto $scheme`, overwriting Traefik's
 * `https` with its own internal `http`. An origin comparison would therefore never
 * match on the public host and would bounce the browser to it forever.
 */
export function resolveOidcOriginBounce(
  origin: OidcCallbackRequestOrigin,
  publicBaseUrl: string | undefined,
  redirectPath?: string,
  alreadyBounced = false,
): string | null {
  // One hop only — never risk a redirect loop on the sign-in path.
  if (alreadyBounced) {
    return null;
  }

  const normalizedBase = normalizePublicBaseUrl(publicBaseUrl);

  if (!normalizedBase) {
    return null;
  }

  let publicUrl: URL;

  try {
    publicUrl = new URL(normalizedBase);
  } catch {
    // A malformed APP_BASE_URL would already break resolveOidcCallbackUrl; do not
    // compound it by bouncing the browser somewhere unparseable.
    return null;
  }

  // `host` (not `hostname`) so a non-default port is part of the comparison.
  if (resolveRequestHost(origin, publicUrl.protocol) === publicUrl.host.toLowerCase()) {
    return null;
  }

  const target = new URL(`${normalizedBase}${INITIATE_PATH}`);

  if (redirectPath) {
    target.searchParams.set('redirect', redirectPath);
  }

  target.searchParams.set(OIDC_ORIGIN_BOUNCE_PARAM, '1');

  return target.toString();
}
