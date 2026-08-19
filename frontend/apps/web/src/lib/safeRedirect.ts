/**
 * Open-redirect guard for post-login destinations.
 *
 * Mirrors the backend's `safeRelativePath` (domains/auth/controllers/OidcController),
 * which validates the OIDC `?redirect=` leg. The client-side navigations —
 * `useAuth`'s password-login `navigate(state.from)` and the `redirect` handed to
 * `OidcButton` — had no equivalent check, so this closes that gap on the paths the
 * server never sees.
 *
 * Only a same-origin relative path survives: a single leading '/', never '//'
 * (protocol-relative, which a browser resolves as an absolute URL — `//evil.com`
 * loads `https://evil.com`), no scheme, and no backslash or control character that a
 * browser might normalise into an origin change. Anything else yields null and the
 * caller falls back to its own default.
 */
export function safeRedirectPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null;
  }

  if (!value.startsWith('/') || value.startsWith('//')) {
    return null;
  }

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x5c || code === 0x7f) {
      return null;
    }
  }

  return value;
}
