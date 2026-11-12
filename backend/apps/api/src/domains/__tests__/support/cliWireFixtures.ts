import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The meeting point between the `ci` CLI and the routes it calls.
 *
 * The CLI (`backend/apps/cli`) restates the bodies it reads in its own
 * `wire.ts` instead of importing server types, so nothing at compile time
 * notices when the two drift. By November 2026, seven commands had: they sent
 * fields the routes did not read, or read fields the routes did not send, and
 * their tests passed because their fixtures were copied from the same wrong
 * types.
 *
 * Each file under the CLI's `src/__tests__/fixtures/wire/` holds, per route,
 * the `request` (or `query`) the CLI sends for one invocation and a `response`
 * that route really produced. Both suites read the same file:
 *
 * - the CLI's tests assert the command sends exactly that request, and render
 *   that response;
 * - the API's `cliWireContract.test.ts` files (one per domain) check that the
 *   request passes the route's real schema with nothing dropped, and that the
 *   route's real output still has the response's shape.
 *
 * When a route's body changes on purpose, run that domain's contract test with
 * `UPDATE_CLI_WIRE_FIXTURES=1` to rewrite the responses, then run the CLI's
 * tests. They are the point of the exercise.
 */
const FIXTURE_DIR = resolve(__dirname, '../../../../../cli/src/__tests__/fixtures/wire');

export interface WireExample {
  request?: unknown;
  query?: Record<string, unknown>;
  response: unknown;
}

export type WireFixture = Record<string, WireExample>;

export function readCliWireFixture(file: string): WireFixture {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, file), 'utf8')) as WireFixture;
}

/**
 * Compare a domain's real responses with its fixture, after rewriting the
 * fixture first when `UPDATE_CLI_WIRE_FIXTURES=1` asks for it.
 *
 * `actual` is keyed like the fixture and holds what the controller returned,
 * before serialization: this applies the JSON round trip the wire does, which
 * turns a `Date` into a string and drops an `undefined`.
 */
export function expectFixtureShapes(file: string, actual: Record<string, unknown>): void {
  const fixture = readCliWireFixture(file);
  const wire = JSON.parse(JSON.stringify(actual)) as Record<string, unknown>;

  if (process.env.UPDATE_CLI_WIRE_FIXTURES === '1') {
    const updated: WireFixture = Object.fromEntries(
      Object.entries(fixture).map(([name, example]) => [name, { ...example, response: wire[name] }]),
    );

    writeFileSync(resolve(FIXTURE_DIR, file), `${JSON.stringify(updated, null, 2)}\n`);
  }

  const committed = readCliWireFixture(file);

  expect(Object.keys(wire).sort()).toEqual(Object.keys(committed).sort());

  for (const [name, example] of Object.entries(committed)) {
    // Keyed by route so a failure names the one that drifted.
    expect({ [name]: wireShape(wire[name]) }).toEqual({ [name]: wireShape(example.response) });
  }
}

/**
 * The query string a GET sends: every value a string, as `URLSearchParams`
 * makes it. What the route's schema sees before coercion.
 */
export function asQueryString(query: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)]));
}

/**
 * Structure without values: the sorted keys of every object, each element of
 * every array, and the JSON type of every leaf. Two bodies with the same shape
 * differ only in data; a renamed, added, removed or retyped field changes it.
 */
export function wireShape(value: unknown): unknown {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return value.map(wireShape);
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, wireShape((value as Record<string, unknown>)[key])]),
    );
  }

  return typeof value;
}
