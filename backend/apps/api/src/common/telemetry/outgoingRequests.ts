/**
 * Outbound requests the HTTP and fetch instrumentation must not record at all.
 *
 * These APIs take the appliance owner's own key as a query parameter, so the
 * request URL is a credential. The scrubbers already strip query strings from
 * every span, breadcrumb and event, but they only see what the SDK built; not
 * instrumenting the call keeps the key out of every one of them at once,
 * including any field a future SDK version adds. The cost is that a slow or
 * failing geocode, TMDB or Steam call no longer shows up as a span.
 */
const HOSTS_WITH_KEY_IN_URL = new Set([
  // GoogleGeocodeProvider: `…/geocode/json?address=<user's address>&key=<owner's key>`
  'maps.googleapis.com',
  // GetStreamingAvailabilityTool: `…?api_key=<key>`
  'api.themoviedb.org',
  // SteamClient (BaseOpenIDClient.requestRaw): `…?steamid=<id>&key=<user's Web API key>`
  'api.steampowered.com',
]);

/** `ignoreOutgoingRequests` for `httpIntegration` and `nativeNodeFetchIntegration`. */
export function isKeyInUrlRequest(url: string): boolean {
  try {
    return HOSTS_WITH_KEY_IN_URL.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}
