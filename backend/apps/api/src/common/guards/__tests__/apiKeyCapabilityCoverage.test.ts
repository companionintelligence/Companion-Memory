import 'reflect-metadata';

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { REQUIRE_CAPABILITY_KEY, REQUIRE_SCOPES_KEY } from '@ci/common/decorators';

import { IntentsController } from '../../../domains/agent/controllers/IntentsController';
import { MemoryController } from '../../../domains/agent/controllers/MemoryController';
import { FilesController } from '../../../domains/files/controllers/FilesController';
import { BulkIngestController } from '../../../domains/ingest/controllers/BulkIngestController';
import { McpController } from '../../../domains/mcp/controllers/McpController';
import { PersonaIntelligenceController } from '../../../domains/persona/controllers/PersonaIntelligenceController';

/**
 * The invariant that makes read-only mean something.
 *
 * `@RequireScopes` marks a route as reachable by a scope-limited api key, and deny-by-default means
 * such a key can reach NOTHING else. So annotating every scoped route with `@RequireCapability`
 * makes capability enforcement complete for those keys — and missing one leaves a hole exactly where
 * the settings UI has promised there is none ("Read-only — cannot record or change anything").
 *
 * Asserted by reading the metadata off the real controllers rather than by reviewing the source, so
 * a route added later cannot quietly opt out of the second axis while opting into the first.
 */
const SCOPED_CONTROLLERS = [
  MemoryController,
  IntentsController,
  McpController,
  PersonaIntelligenceController,
  // The `capture` tier. Both grant at the CLASS level, which is why
  // effectiveMetadata() below falls back to the class — a per-method scan alone
  // would see these as unscoped and skip the capability assertion entirely.
  FilesController,
  BulkIngestController,
];

/** Every own method on a controller prototype (route handlers and helpers alike). */
function methodsOf(controller: new (...args: never[]) => object): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');
}

/** Metadata as the guards read it: a method's own value, else the class's. */
function effectiveMetadata(
  key: string,
  controller: new (...args: never[]) => object,
  method: string,
): unknown {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  const onHandler = typeof handler === 'function' ? Reflect.getMetadata(key, handler) : undefined;

  return onHandler ?? Reflect.getMetadata(key, controller);
}

describe('every api-key-reachable route declares a capability', () => {
  for (const controller of SCOPED_CONTROLLERS) {
    describe(controller.name, () => {
      for (const method of methodsOf(controller)) {
        const scopes = effectiveMetadata(REQUIRE_SCOPES_KEY, controller, method);

        // Only routes that grant a scope are reachable by a scope-limited key; helpers and
        // un-scoped methods are out of the api-key surface entirely.
        if (!Array.isArray(scopes) || scopes.length === 0) {
          continue;
        }

        it(`${method} states what it may do, not only where it lives`, () => {
          expect(effectiveMetadata(REQUIRE_CAPABILITY_KEY, controller, method)).toBeDefined();
        });
      }
    });
  }

  it('covers the routes it claims to — the controllers really do declare scopes', () => {
    // Guards the guard: if the metadata keys or decorators were ever renamed, every assertion above
    // would vacuously pass on an empty loop, and this suite would report green while checking nothing.
    const scoped = SCOPED_CONTROLLERS.flatMap((controller) =>
      methodsOf(controller).filter((method) => {
        const scopes = effectiveMetadata(REQUIRE_SCOPES_KEY, controller, method);

        return Array.isArray(scopes) && scopes.length > 0;
      }),
    );

    expect(scoped.length).toBeGreaterThanOrEqual(5);
  });

  it('checks every scoped controller in the tree, not just the ones listed here', () => {
    // The assertions above iterate SCOPED_CONTROLLERS, a hand-written list. That catches a new
    // ROUTE on a known controller, but a whole new CONTROLLER applying @RequireScopes would never
    // be looked at — it would grant a scope-limited key a reachable route with no capability
    // declared, which is the exact hole this suite exists to prevent, arriving by the one door the
    // suite does not watch.
    //
    // So the list is checked against the source tree rather than trusted. Scanning text (not the
    // Nest container) keeps this a unit test: importing every module to walk the DI graph would
    // pull in database and queue wiring for an assertion about decorators.
    const listed = new Set(SCOPED_CONTROLLERS.map((controller) => controller.name));
    const found = new Set<string>();

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
          // The decorator's own definition and its usage examples are not applications of it.
          if (entry.name !== '__tests__' && entry.name !== 'decorators') {
            walk(path);
          }

          continue;
        }

        if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes('@RequireScopes(')) {
          found.add(entry.name.replace(/\.ts$/, ''));
        }
      }
    };

    walk(resolve(__dirname, '..', '..', '..'));

    expect([...found].sort()).toEqual([...listed].sort());
  });
});
