import { getWebOrigin } from '@ci/common';

/**
 * Pure builders for a saved-search share link. Kept out of the modal component so
 * the `/shared/<token>` route contract (consumed by SharedSearchPage + the App
 * router) can be unit-tested without a DOM. `origin` is a param (defaulting to
 * the Memory origin) so the builders stay pure and SSR-safe.
 *
 * The default is {@link getWebOrigin}, not `window.location.origin`: inside the
 * bundled iOS/Android app the page origin is `capacitor://localhost` /
 * `https://localhost`, which only exists in that WebView, so the link (and the
 * QR code that encodes it) was dead on every other device. The native shells
 * link to the Memory server they are connected to instead.
 */

/** The capability URL a recipient opens: `<origin>/shared/<token>`. */
export function shareUrl(token: string, origin: string = getWebOrigin()): string {
  return `${origin}/shared/${token}`;
}
