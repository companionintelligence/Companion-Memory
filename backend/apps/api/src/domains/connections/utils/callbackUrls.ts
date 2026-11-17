import type { IncomingHttpHeaders } from 'http';

import {
  type OidcCallbackRequestOrigin,
  readRequestOrigin,
  requestNamesHost,
  resolveRequestOrigin,
} from '@ci/common/http/oidcCallbackUrl';
import config from '@ci/configuration';

import type { Connection } from '../entities/ConnectionEntity';

/** The parts of a request the address the browser used is read from, the same four sign-in reads. */
export type CallbackRequestOrigin = OidcCallbackRequestOrigin;

/**
 * Where a connected service sends the person back after they approve it: the OAuth `redirect_uri`
 * the provider is given and the address the OAuth Setup dialog asks people to register with their
 * own OAuth app. The first of these that is set wins:
 *
 * 1. `OAUTH_CALLBACK_URL` (`auth.oauth.callbackUrl`), as given apart from a doubled slash in its
 *    path (see {@link singleSlashPath}).
 * 2. `APP_PUBLIC_URL`, plus `/oauth/callback`.
 * 3. `APP_BASE_URL` (`auth.oidc.publicBaseUrl`), the public origin sign-in already builds its own
 *    callback from, plus `/oauth/callback`.
 * 4. `https://<APP_PUBLIC_HOSTNAME>/oauth/callback`, when APP_PUBLIC_HOSTNAME is set.
 * 5. The address the browser used for `request`, plus `/oauth/callback`: what sign-in falls back to
 *    when APP_BASE_URL is unset ({@link browserOrigin}).
 * 6. `https://<hostname>/oauth/callback` from the built-in hostname (ci-server.localhost), when
 *    there is no request or its headers make no plain http(s) origin.
 *
 * A value for 2 or 3 that is not an absolute http(s) address is passed over.
 *
 * Memory Desktop and Hub installs set 1 to 3 and so does a plain install with APP_BASE_URL in its
 * `.env`: they never read the request. A plain install without it (the production compose file,
 * no Hub, no Desktop) sets none of 1 to 4. It is not served at ci-server.localhost, so without 5
 * connecting a service could never finish there.
 *
 * Every caller used to build its own fallback as `` `${process.env.APP_PUBLIC_URL}/oauth/callback` ``,
 * which is never empty: with the variable unset it is "undefined/oauth/callback", so the next
 * fallback never ran, the dialog showed that and providers were sent it as `redirect_uri`.
 */
export function oauthCallbackUrl(request?: CallbackRequestOrigin): string {
  return callbackUrl(config.auth.oauth.callbackUrl, '/oauth/callback', request);
}

/**
 * The address CI Portal returns a proxied connect to: {@link oauthCallbackUrl} with the connection's
 * id added, so the callback page knows which connection to complete.
 *
 * Never read from the request. CI Portal does not check this address against anything and sends
 * the provider's tokens to it, so one built from a forged Host or X-Forwarded-Host would make
 * Memory hand CI Portal an authorization link that delivers whoever approves it to another site.
 * A person's own OAuth app is different: the provider only returns to addresses registered with
 * that app. CI Portal connects need the device credentials a Hub hands its apps (HUB_DEVICE_ID,
 * HUB_API_KEY). No compose file here passes them and a Hub also sets APP_BASE_URL, so this gives
 * up nothing a plain install could use.
 */
export function oauthCallbackUrlForConnection(connectionId: string): string {
  const base = oauthCallbackUrl();
  const separator = base.includes('?') ? '&' : '?';

  return `${base}${separator}connectionId=${encodeURIComponent(connectionId)}`;
}

/** Where an OpenID 2.0 service (Steam) returns to, chosen the same way from `OPENID_CALLBACK_URL`. */
export function openIdCallbackUrl(request?: CallbackRequestOrigin): string {
  return callbackUrl(config.auth.openid.callbackUrl, '/openid/callback', request);
}

/**
 * What {@link oauthCallbackUrl} needs from a request, read by the same {@link readRequestOrigin}
 * sign-in uses. Undefined without a request (a caller outside HTTP, or a test).
 */
export function callbackRequestOrigin(request?: {
  headers?: IncomingHttpHeaders;
  secure?: boolean;
}): CallbackRequestOrigin | undefined {
  if (request?.headers == null) {
    return undefined;
  }

  return readRequestOrigin({ headers: request.headers, secure: request.secure });
}

function callbackUrl(configured: string | undefined, path: string, request?: CallbackRequestOrigin): string {
  const explicit = configured?.trim();

  if (explicit) {
    return singleSlashPath(explicit);
  }

  const base = [process.env.APP_PUBLIC_URL, config.auth.oidc.publicBaseUrl]
    .map((value) => value?.trim().replace(/\/+$/, ''))
    .find((value) => !!value && isAbsoluteHttpUrl(value));

  if (base) {
    return `${base}${path}`;
  }

  // An APP_PUBLIC_HOSTNAME the install sets is its address. Only the built-in one gives way.
  const origin = (!process.env.APP_PUBLIC_HOSTNAME?.trim() && request && browserOrigin(request)) || undefined;

  return origin ? `${origin}${path}` : `https://${config.hostname}${path}`;
}

/**
 * The redirect_uri to exchange a connection's authorization code with: the one its authorization
 * was sent with, else (a connection authorized before that was kept) {@link oauthCallbackUrl} for
 * the callback page's request.
 */
export function exchangeRedirectUri(
  connection: Pick<Connection, 'oauthRedirectUri'>,
  request?: CallbackRequestOrigin,
): string {
  return connection.oauthRedirectUri?.trim() || oauthCallbackUrl(request);
}

/** The redirect_uri an authorization address sends the provider, or null when it names none. */
export function sentRedirectUri(authorizationUrl: string): string | null {
  try {
    return new URL(authorizationUrl).searchParams.get('redirect_uri');
  } catch {
    return null;
  }
}

/** A host name or IP literal and an optional port, with nothing that would add a path or credentials. */
const HOST_AND_PORT = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * The origin the browser used for this request, worked out by sign-in's own
 * {@link resolveRequestOrigin} (the first X-Forwarded-Host, else Host; the first
 * X-Forwarded-Proto, else the connection's scheme), so the two trust the same headers. The
 * gateway passes Host through, sets X-Forwarded-Proto to http or https and passes on an
 * X-Forwarded-Host the caller sent unchanged, so any caller can name the address for its own
 * request.
 *
 * It answers only the request it came from: the dialog that asked, or the authorization the same
 * person starts with their own OAuth app, which keeps the address on the connection for its code
 * exchange. A forged Host or X-Forwarded-Host changes no other request's address and no other
 * connection's. The provider refuses an address not registered with the app, a browser does not
 * let another site set either header and CI Portal connects never use this.
 *
 * Undefined when the headers do not make a plain http(s) origin, so a value carrying a path, a
 * user name or a stray character never ends up in a `redirect_uri`. Undefined too when the request
 * names no host: sign-in's "localhost" stand-in is no address for a provider to return anyone to.
 */
function browserOrigin(request: CallbackRequestOrigin): string | undefined {
  if (!requestNamesHost(request)) {
    return undefined;
  }

  const origin = resolveRequestOrigin(request);
  const match = /^(https?):\/\/(.*)$/i.exec(origin);

  if (!match || !HOST_AND_PORT.test(match[2])) {
    return undefined;
  }

  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}

/**
 * The compose files build the callback variables as `${APP_BASE_URL}/oauth/callback`, so an
 * APP_BASE_URL ending in a slash gives "http://host:8642//oauth/callback". The web app's router
 * does not match "//oauth/callback", so the person would land on the not-found page with the code
 * unspent. Only a run of slashes in the path is collapsed; the rest of the string stays as given,
 * since providers compare `redirect_uri` character for character.
 */
function singleSlashPath(url: string): string {
  return url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)/i,
    (_match, origin: string, pathname: string) => `${origin}${pathname.replace(/\/{2,}/g, '/')}`,
  );
}

/**
 * Whether a base address can have a path appended. A scheme-less value such as "memory.example.com"
 * would give "memory.example.com/oauth/callback". Providers refuse that, and Steam's connect throws
 * where it parses the return address.
 */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);

    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
