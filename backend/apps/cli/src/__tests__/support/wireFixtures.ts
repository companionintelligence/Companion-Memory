import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One route's worth of a wire fixture: the request (or query) the CLI sends
 * for one invocation, and a response the route really produced.
 *
 * These files are not this package's idea of the server. The API's
 * `cliWireContract.test.ts` suites (helper:
 * `backend/apps/api/src/domains/__tests__/support/cliWireFixtures.ts`) check
 * every request against the route's real schema and every response against
 * the route's real output, so a test that sends `request` and renders
 * `response` is testing against the server as it is, not as `wire.ts` says.
 */
export interface WireExample {
  request?: unknown;
  query?: Record<string, unknown>;
  response: unknown;
}

export function wireFixture(file: string): Record<string, WireExample> {
  return JSON.parse(readFileSync(resolve(__dirname, '../fixtures/wire', file), 'utf8')) as Record<
    string,
    WireExample
  >;
}
