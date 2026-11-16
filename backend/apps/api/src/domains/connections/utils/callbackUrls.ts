import config from '@ci/configuration';

/**
 * Where a connected service sends the person back after they approve it: the OAuth `redirect_uri`
 * the provider is given and the address the OAuth Setup dialog asks people to register with their
 * own OAuth app. The first of these that is set wins:
 *
 * 1. `OAUTH_CALLBACK_URL` (`auth.oauth.callbackUrl`), as given.
 * 2. `APP_PUBLIC_URL`, plus `/oauth/callback`.
 * 3. `APP_BASE_URL` (`auth.oidc.publicBaseUrl`), the public origin sign-in already builds its own
 *    callback from, plus `/oauth/callback`.
 * 4. `https://<APP_PUBLIC_HOSTNAME>/oauth/callback`, from the configured hostname.
 *
 * Every caller used to build its own fallback as `` `${process.env.APP_PUBLIC_URL}/oauth/callback` ``,
 * which is never empty: with the variable unset it is "undefined/oauth/callback", so the next
 * fallback never ran, the dialog showed that and providers were sent it as `redirect_uri`.
 */
export function oauthCallbackUrl(): string {
  return callbackUrl(config.auth.oauth.callbackUrl, '/oauth/callback');
}

/** Where an OpenID 2.0 service (Steam) returns to, chosen the same way from `OPENID_CALLBACK_URL`. */
export function openIdCallbackUrl(): string {
  return callbackUrl(config.auth.openid.callbackUrl, '/openid/callback');
}

function callbackUrl(configured: string | undefined, path: string): string {
  const explicit = configured?.trim();

  if (explicit) {
    return explicit;
  }

  const base = [process.env.APP_PUBLIC_URL, config.auth.oidc.publicBaseUrl]
    .map((value) => value?.trim().replace(/\/+$/, ''))
    .find((value) => !!value);

  return base ? `${base}${path}` : `https://${config.hostname}${path}`;
}
