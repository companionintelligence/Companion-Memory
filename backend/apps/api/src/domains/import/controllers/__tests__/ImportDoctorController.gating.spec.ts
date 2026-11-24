import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { ImportDoctorController } from '../ImportDoctorController';

/**
 * Pins the administrator gate on `GET /import/doctor`, read from Nest's
 * decorator metadata like `maintenance/__tests__/applianceAdminGating.spec.ts`:
 * the assertion is on what the controller DECLARES, so dropping the guard fails
 * here without a running app.
 *
 * The data reason: every check scans all accounts and returns a sample row from
 * whichever one owns the defect. Before this gate a household member running
 * `ci doctor` read the owner's and other members' names, locations and errors.
 */
const GUARDS_METADATA = '__guards__';
const PATH_METADATA = 'path';

function guardsOn(method: string): unknown[] {
  const handler = (ImportDoctorController.prototype as unknown as Record<string, unknown>)[method] as object;
  expect(Reflect.getMetadata(PATH_METADATA, handler)).toBeDefined();

  return (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
}

describe('ImportDoctorController — doctor results are administrator-only', () => {
  it('GET /import/doctor carries the admin guard on top of authentication', () => {
    const guards = guardsOn('run');
    expect(guards).toContain(JwtOrApiKeyAuthGuard);
    expect(guards).toContain(ApplianceAdminGuard);
  });

  it('GET /import/doctor/checks authenticates but is not admin-only — it leaks no data', () => {
    const guards = guardsOn('listChecks');
    expect(guards).toContain(JwtOrApiKeyAuthGuard);
    expect(guards).not.toContain(ApplianceAdminGuard);
  });
});
