/**
 * The URL a provider client sends a request to, with the connection's credential attached.
 *
 * A provider client takes a path, which goes on its `baseUrl`, or an absolute URL: a pagination link
 * (`paging.next`, `@odata.nextLink`, a GitHub `Link` header) or a stored sync cursor. Those come from
 * the provider's own responses, or from a cursor saved from one, and the client attaches the user's
 * access token (or Steam's API key) to whatever it is given. Any `https://` host used to do: a
 * response, a cursor or a bug that named another host was handed the user's token.
 *
 * So an absolute URL must be `https:` and on the provider's own API: the `baseUrl`'s host, a host
 * under the same domain (`content.dropboxapi.com` beside `api.dropboxapi.com`, `gmail.googleapis.com`
 * beside `www.googleapis.com`), or one the client names in `extraHosts`. Anything else throws before
 * the request is made.
 */
export function providerApiUrl(
  baseUrl: string,
  endpoint: string,
  extraHosts: readonly string[] = [],
): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint)) {
    return `${baseUrl}${endpoint}`;
  }

  let target: URL;
  try {
    target = new URL(endpoint);
  } catch {
    throw new Error('Refusing to send a provider credential to an unreadable URL');
  }

  const base = new URL(baseUrl);
  const host = target.hostname.toLowerCase();
  const domain = registrableDomain(base.hostname.toLowerCase());
  const allowed =
    target.protocol === 'https:' &&
    !target.username &&
    !target.password &&
    (host === domain ||
      host.endsWith(`.${domain}`) ||
      extraHosts.some((extra) => extra.toLowerCase() === host));

  if (!allowed) {
    throw new Error(`Refusing to send the ${base.hostname} credential to ${target.protocol}//${host}`);
  }

  return target.toString();
}

/**
 * The last two labels of a host: the domain a provider's API hosts share. Every provider client's
 * `baseUrl` is under a two-label domain (`googleapis.com`, `dropboxapi.com`, `slack.com`); one under a
 * public suffix of more labels (`example.co.uk`) would need its hosts listed in `extraHosts` instead.
 */
function registrableDomain(host: string): string {
  return host.split('.').slice(-2).join('.');
}
