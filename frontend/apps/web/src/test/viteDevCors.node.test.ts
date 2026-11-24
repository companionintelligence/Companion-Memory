import { describe, expect, it } from 'vitest';

import config from '../../vite.config';

/**
 * Vite's dev server answers every CORS preflight itself, before it proxies `/api`
 * to the API, and its default allowlist is http(s) localhost only. The bundled iOS
 * shell calls it from `capacitor://localhost`, so its preflight came back with no
 * `Access-Control-Allow-Origin`, the WebView refused the streaming chat request,
 * and `streamingFetch` fell back to the buffered CapacitorHttp path: whole replies
 * after the generation ended, and no Stop control, because nothing was ever
 * "streaming". The appliance origin (nginx in front of the API, which allows the
 * native origins in `main.ts`) was never affected.
 *
 * This reads the allowlist the way the `cors` middleware does — a request origin is
 * allowed if it equals a string rule or matches a RegExp rule — so a change to the
 * config that drops a native origin, or opens the dev server to the world, fails here.
 */
function allowedOrigins(): Array<string | RegExp> {
  const cors = (config.server as { cors?: { origin?: unknown } } | undefined)?.cors;

  if (cors == null || typeof cors !== 'object' || !Array.isArray(cors.origin)) {
    return [];
  }

  return cors.origin as Array<string | RegExp>;
}

function allows(origin: string): boolean {
  return allowedOrigins().some((rule) => (typeof rule === 'string' ? rule === origin : rule.test(origin)));
}

describe('vite dev server CORS', () => {
  it.each(['capacitor://localhost', 'ionic://localhost'])(
    'answers the iOS shell’s preflight for %s',
    (origin) => {
      expect(allows(origin)).toBe(true);
    },
  );

  it.each(['http://localhost', 'https://localhost', 'http://localhost:5173', 'http://127.0.0.1:5173'])(
    'keeps Vite’s own localhost allowance, which the Android shell relies on: %s',
    (origin) => {
      expect(allows(origin)).toBe(true);
    },
  );

  it.each([
    'https://evil.example',
    'http://192.168.0.4:5173',
    'capacitor://evil.example',
    'http://localhost.evil.example',
  ])('does not open the dev server to %s', (origin) => {
    expect(allows(origin)).toBe(false);
  });
});
