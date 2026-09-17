import 'reflect-metadata';

import {
  FULL_CAPABILITY,
  READ_CAPABILITY,
  REQUIRE_CAPABILITY_KEY,
  WRITE_CAPABILITY,
} from '@ci/common/decorators';

import { BulkFilesController } from '../../../domains/files/controllers/BulkFilesController';
import { IngestLifecycleController } from '../../../domains/ingest/controllers/IngestLifecycleController';
import { MaintenanceController } from '../../../domains/maintenance/controllers/MaintenanceController';

/**
 * The other half of the invariant `apiKeyCapabilityCoverage.test.ts` pins.
 *
 * That suite watches controllers carrying `@RequireScopes`, because deny-by-default
 * means a scope-LIMITED key can reach nothing else. It cannot see the gap CI-Server#1780
 * describes, which belongs to keys with NO scopes at all: `enforceApiKeyScopes` returns
 * early for them, so scope enforcement never runs and capability is the only axis left —
 * and on these three controllers nothing was reading it.
 *
 * What that meant in practice, before this file existed: a key the settings UI calls
 * "Read-only - cannot record or change anything" could run all 31 maintenance sweeps,
 * post 50 x 1 GB files to `/v1/files`, and truncate its own ingested data through
 * `POST /maintenance/ingest/reset`.
 *
 * Asserted off the real metadata rather than by reading the source, so a route added
 * later cannot quietly rejoin the un-annotated set.
 */
const CONTROLLERS = [MaintenanceController, IngestLifecycleController, BulkFilesController];

const HTTP_METHOD_KEY = 'method';

function routesOf(controller: new (...args: never[]) => object): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => {
    if (name === 'constructor') {
      return false;
    }

    const handler = (controller.prototype as Record<string, unknown>)[name];

    return typeof handler === 'function' && Reflect.getMetadata(HTTP_METHOD_KEY, handler) !== undefined;
  });
}

function effectiveCapability(controller: new (...args: never[]) => object, method: string): unknown {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  const onHandler =
    typeof handler === 'function' ? Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, handler) : undefined;

  return onHandler ?? Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, controller);
}

describe('routes reachable by an empty-scope key declare a capability', () => {
  for (const controller of CONTROLLERS) {
    describe(controller.name, () => {
      for (const method of routesOf(controller)) {
        it(`${method} states what it may do`, () => {
          expect(effectiveCapability(controller, method)).toBeDefined();
        });
      }
    });
  }

  it('is actually looking at routes — the discovery really finds handlers', () => {
    // Guards the guard: if the Nest metadata key or the decorators were renamed, every
    // assertion above would vacuously pass on an empty loop and report green.
    const total = CONTROLLERS.reduce((sum, controller) => sum + routesOf(controller).length, 0);

    expect(total).toBeGreaterThanOrEqual(30);
  });
});

describe('the routes that lose data ask for more than write', () => {
  it('POST maintenance/ingest/reset requires full — it truncates', () => {
    // `capabilityAllows` refuses anything that removes data below `full`. This is the
    // same line `memory.forget` sits behind, and the sharpest case in #1780: the confirm
    // literal on this route proves the caller MEANT it, never that they were entitled to.
    expect(effectiveCapability(MaintenanceController, 'resetIngest')).toBe(FULL_CAPABILITY);
  });

  it('the maintenance sweeps require write, and its status reads require only read', () => {
    // A class-level `write` with per-route `read` on the five genuine GETs — so turning
    // the axis on does not wrongly refuse a status check to a read-only key.
    expect(effectiveCapability(MaintenanceController, 'ingestStatus')).toBe(READ_CAPABILITY);
    expect(effectiveCapability(MaintenanceController, 'geocodeLocations')).toBe(WRITE_CAPABILITY);
  });

  it('v1/ingest splits by route: finish writes, status reads', () => {
    expect(effectiveCapability(IngestLifecycleController, 'finish')).toBe(WRITE_CAPABILITY);
    expect(effectiveCapability(IngestLifecycleController, 'status')).toBe(READ_CAPABILITY);
  });
});
