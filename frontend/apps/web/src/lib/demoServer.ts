/**
 * The hosted, reviewer-facing Companion Memory instance.
 *
 * Companion Memory is self-hosted: there is no single cloud origin, so the native
 * client normally has to be *told* where its Memory Server lives. That is fine for a
 * real user and fatal for an App Store / Play reviewer, who has no appliance and no
 * reason to know a hostname — a self-hosted client with no reviewer-reachable backend
 * is a well-known automatic rejection, and a mistyped hostname is its own rejection
 * path. This module backs a one-tap "Try the demo" affordance so the reviewer never
 * types anything.
 *
 * The origin is a BUILD-TIME value (`VITE_DEMO_SERVER_URL`), not a hardcoded constant,
 * and when it is absent or unusable nothing renders. A "Try the demo" button that
 * fails is worse than no button at all, so the bar for showing one is deliberately
 * high:
 *
 * - **https only.** The demo exists to prove the encrypted path a reviewer actually
 *   exercises; an `http://` demo origin would quietly undermine the store Data-Safety
 *   answers it is meant to support. A non-https value is treated as unconfigured.
 * - **Origin only.** Any path/query/hash is stripped, so `${origin}/api/...` always
 *   resolves the way `buildApiUrl` expects.
 *
 * NOTE: no credential ever belongs here. The reviewer signs in with the Portal demo
 * account, whose password lives in App Store Connect review notes and the Play
 * Console — never in this repo.
 */

import { persistApiBaseUrl } from '@ci/common';

/** How long to wait for the demo server's health check before calling it unreachable. */
export const HEALTH_CHECK_TIMEOUT_MS = 8000;

/**
 * Verify an origin is actually serving a Memory Server before the app commits to it.
 * `/api/health` is unauthenticated, so a 2xx is a sufficient (and cheap) liveness
 * signal. Throws on a non-2xx or on the caller-visible `AbortError` timeout.
 */
export async function healthCheckOrigin(origin: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`${origin}/api/health`, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Memory Server responded with ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Normalize a raw build value to a usable demo origin, or `null` when there is not
 * one. Exported separately from `getDemoServerOrigin` so the rules can be tested
 * directly: `import.meta.env` is inlined at build time and is not reachable from a
 * test in another module (`vi.stubEnv` only reaches `process.env`), so a pure
 * function is the only honest way to cover them.
 */
export function parseDemoServerOrigin(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);

    // https only — see the module comment. `http:` is unconfigured, not a fallback.
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The configured demo origin, or `null` when the build has none. Callers must treat
 * `null` as "render no demo affordance at all" rather than substituting a default —
 * guessing a hostname is the failure mode this whole module exists to prevent.
 */
export function getDemoServerOrigin(): string | null {
  return parseDemoServerOrigin(import.meta.env.VITE_DEMO_SERVER_URL);
}

/**
 * Point the app at the demo instance: health-check first, and only persist an origin
 * that answered. A dead demo server must surface as an error the tester can read, not
 * as an app silently wired to an origin that will fail on every later request.
 *
 * Takes the origin rather than re-reading the build value so the caller's `null`
 * check is the single gate, and so this stays a pure function of its argument.
 */
export async function connectToDemoServer(origin: string): Promise<void> {
  await healthCheckOrigin(origin);

  persistApiBaseUrl(origin);
}
