import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { LlmEndpointController } from '../LlmEndpointController';

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

describe('LlmEndpointController — repointing the endpoint is administrator-only', () => {
  it('PATCH carries the admin guard after the auth guard; the reads do not', () => {
    // There is ONE inference endpoint per appliance: every user's prompts and the
    // stored bearer follow it. Any signed-in account could repoint it before this.
    const update = guardsOn(LlmEndpointController, 'updateEndpoint');
    expect(update).toContain(JwtOrApiKeyAuthGuard);
    expect(update).toContain(ApplianceAdminGuard);
    // Order matters: the auth guard must populate request.user before the admin guard reads it.
    expect(update.indexOf(JwtOrApiKeyAuthGuard)).toBeLessThan(update.indexOf(ApplianceAdminGuard));

    for (const method of ['getEndpoint', 'preflightEndpoint']) {
      expect(guardsOn(LlmEndpointController, method)).toContain(JwtOrApiKeyAuthGuard);
      expect(guardsOn(LlmEndpointController, method)).not.toContain(ApplianceAdminGuard);
    }
  });
});
