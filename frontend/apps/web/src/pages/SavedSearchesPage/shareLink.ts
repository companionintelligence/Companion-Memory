/**
 * Pure builders for a saved-search share link. Kept out of the modal component so
 * the `/shared/<token>` route contract (consumed by SharedSearchPage + the App
 * router) can be unit-tested without a DOM. `origin` is a param (defaulting to
 * the current window) so the builders stay pure and SSR-safe.
 */

function currentOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/** The capability URL a recipient opens: `<origin>/shared/<token>`. */
export function shareUrl(token: string, origin: string = currentOrigin()): string {
  return `${origin}/shared/${token}`;
}

/** An embeddable iframe snippet for the shared search. */
export function iframeSnippet(token: string, origin: string = currentOrigin()): string {
  return `<iframe frameborder="0" width="100%" height="600" src="${shareUrl(token, origin)}"></iframe>`;
}
