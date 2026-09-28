import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { BlueBubblesConfigController } from '../BlueBubblesConfigController';

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

describe('BlueBubblesConfigController — writing the appliance-wide config is administrator-only', () => {
  it('every non-GET route carries the admin guard after the auth guard; GET stays readable by any user', () => {
    // The configuration is one row for the whole appliance, and test-connection makes the
    // appliance dial an arbitrary host:port and report back.
    const prototype = BlueBubblesConfigController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(prototype).filter(
      (name) =>
        name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, prototype[name] as object) !== undefined,
    );
    expect(routes.length).toBeGreaterThanOrEqual(4);

    for (const method of routes) {
      // RequestMethod.GET === 0 in Nest's enum.
      const httpMethod = Reflect.getMetadata('method', prototype[method] as object) as number;
      const guards = guardsOn(BlueBubblesConfigController, method);
      expect(guards).toContain(JwtOrApiKeyAuthGuard);

      if (httpMethod === 0) {
        expect(guards).not.toContain(ApplianceAdminGuard);
      } else {
        expect(guards).toContain(ApplianceAdminGuard);
        expect(guards.indexOf(JwtOrApiKeyAuthGuard)).toBeLessThan(guards.indexOf(ApplianceAdminGuard));
      }
    }
  });
});
