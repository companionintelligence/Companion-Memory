import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { MaintenanceController } from '../controllers/MaintenanceController';

/**
 * Pins the administrator gate on routes that change something for EVERY user of
 * the appliance, read via Nest's decorator metadata like
 * `events/__tests__/jobsControllerGating.spec.ts`: the assertion is on what the
 * controller DECLARES, so a refactor that drops a `@UseGuards` fails here
 * without a running app. Kept per domain — the dependency rules forbid a spec
 * in one domain importing another domain's controller.
 */
const GUARDS_METADATA = '__guards__';
const PATH_METADATA = 'path';

function guardsOn(controller: abstract new (...args: never[]) => unknown, method: string): unknown[] {
  const handler = (controller.prototype as Record<string, unknown>)[method] as object;
  // Guards against asserting on a helper that is not a route at all.
  expect(Reflect.getMetadata(PATH_METADATA, handler)).toBeDefined();

  return (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
}

describe('MaintenanceController — appliance-wide sweeps are administrator-only', () => {
  it('the class authenticates every route', () => {
    const classGuards =
      (Reflect.getMetadata(GUARDS_METADATA, MaintenanceController) as unknown[] | undefined) ?? [];
    expect(classGuards).toContain(JwtOrApiKeyAuthGuard);
  });

  it('the three search-index sweeps carry the admin guard on top of it', () => {
    // Before this, any signed-in account — a household member included — could truncate,
    // backfill or orphan-sweep the search index across all users.
    for (const method of ['cleanupSearchOrphans', 'truncateSearchIndex', 'backfillSearchIndex']) {
      expect(guardsOn(MaintenanceController, method)).toContain(ApplianceAdminGuard);
    }
  });
});
