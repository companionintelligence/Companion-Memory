import config from '@ci/configuration';

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
 * 4. `https://<APP_PUBLIC_HOSTNAME>/oauth/callback`, from the configured hostname.
 *
 * A value for 2 or 3 that is not an absolute http(s) address is passed over.
 *
 * Every caller used to build its own fallback as `` `${process.env.APP_PUBLIC_URL}/oauth/callback` ``,
 * which is never empty: with the variable unset it is "undefined/oauth/callback", so the next
 * fallback never ran, the dialog showed that and providers were sent it as `redirect_uri`.
 */
export function oauthCallbackUrl(): string {
  return callbackUrl(config.auth.oauth.callbackUrl, '/oauth/callback');
}

/**
 * The address CI Portal returns a proxied connect to: {@link oauthCallbackUrl} with the connection's
 * id added, so the callback page knows which connection to complete.
 */
export function oauthCallbackUrlForConnection(connectionId: string): string {
  const base = oauthCallbackUrl();
  const separator = base.includes('?') ? '&' : '?';

  return `${base}${separator}connectionId=${encodeURIComponent(connectionId)}`;
}

/** Where an OpenID 2.0 service (Steam) returns to, chosen the same way from `OPENID_CALLBACK_URL`. */
export function openIdCallbackUrl(): string {
  return callbackUrl(config.auth.openid.callbackUrl, '/openid/callback');
}

function callbackUrl(configured: string | undefined, path: string): string {
  const explicit = configured?.trim();

  if (explicit) {
    return singleSlashPath(explicit);
  }

  const base = [process.env.APP_PUBLIC_URL, config.auth.oidc.publicBaseUrl]
    .map((value) => value?.trim().replace(/\/+$/, ''))
    .find((value) => !!value && isAbsoluteHttpUrl(value));

  return base ? `${base}${path}` : `https://${config.hostname}${path}`;
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
