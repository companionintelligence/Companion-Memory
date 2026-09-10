import {
  FULL_CAPABILITY,
  REQUIRE_CAPABILITY_KEY,
  REQUIRE_SCOPES_KEY,
  isCapabilityPromotion,
  type ApiKeyCapability,
} from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { JobsController } from '../controllers/JobsController';

/**
 * The gating ladder on `JobsController`, asserted over EVERY route rather than over a
 * hand-listed set.
 *
 * These routes are appliance-wide — `JobMonitorService`/`JobQueryService` carry no tenancy
 * predicate — and no guard can make them per-account, so the one property this controller can
 * actually hold is the relative one: `POST jobs/crons/run`, which fires every registered
 * `@Cron` (including `AccountPurgeCron.purgeDueAccounts`), stays the most strongly gated route
 * here. That property is only meaningful if every OTHER route states its floor too — a route
 * with no `@RequireCapability` is not a low rung, it is an unchecked one — which is why the
 * handler list below is derived from the prototype instead of written out. A route added later
 * without a capability fails this suite rather than quietly landing under the acting one.
 *
 * `AdminOnlyGuard` is deliberately not among the guards asserted here; see the controller's own
 * doc comment for why `ApplianceAdminGuard` is the right one for an appliance-wide control plane
 * (it degrades open on an appliance with no live admin, which the arbitrary-command-execution
 * routes behind `AdminOnlyGuard` must not).
 */

/** Nest's own metadata key for a handler's route path (`@nestjs/common` PATH_METADATA). */
const PATH_METADATA = 'path';

interface RouteHandler {
  name: string;
  handler: object;
  capability: ApiKeyCapability | undefined;
}

function routeHandlers(): RouteHandler[] {
  const prototype = JobsController.prototype as unknown as Record<string, unknown>;

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = prototype[name] as object;

      return {
        name,
        handler,
        capability: Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, handler) as ApiKeyCapability | undefined,
      };
    })
    .filter(({ handler }) => Reflect.getMetadata(PATH_METADATA, handler) !== undefined);
}

const handlers = routeHandlers();

describe('JobsController gating', () => {
  it('finds every route on the controller', () => {
    // Guards against the reflection above silently matching nothing, which would leave
    // every assertion below vacuously passing.
    expect(handlers.map(({ name }) => name).sort()).toEqual([
      'categoryHistory',
      'clearTerminal',
      'controls',
      'getDashboard',
      'history',
      'list',
      'runCrons',
      'types',
      'updateControls',
    ]);
  });

  it.each(handlers)('$name is guarded by JwtOrApiKeyAuthGuard', ({ handler }) => {
    const guards = Reflect.getMetadata('__guards__', handler) as unknown[] | undefined;

    expect(guards).toContain(JwtOrApiKeyAuthGuard);
  });

  it.each(handlers)('$name states a capability floor', ({ capability }) => {
    expect(capability).toBeDefined();
  });

  it.each(handlers)('$name declares no scopes, so no scope-limited key reaches it', ({ handler }) => {
    // Scope enforcement is deny-by-default: declaring a scope here would OPEN these
    // appliance-wide routes to scope-limited keys, not confine them.
    expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, JobsController)).toBeUndefined();
  });

  // The routes that ACT, as opposed to read. `runCrons` fires every cron;
  // `clearTerminal` deletes the dead-letter/failed queues. Both are gated at
  // `full`, and the invariant is that nothing else on the controller reaches
  // that rung — not that `runCrons` is alone at the top, which is what this
  // asserted before clearTerminal was added (it acts too, so it was correctly
  // given the same floor, and this test failed for saying otherwise).
  const ACTING_ROUTES = ['runCrons', 'clearTerminal'];

  it.each(ACTING_ROUTES)('%s, which acts, is gated at the full capability', (name) => {
    expect(handlers.find((handler) => handler.name === name)?.capability).toBe(FULL_CAPABILITY);
  });

  it('gates every read strictly below the acting routes', () => {
    // `isCapabilityPromotion(from, to)` is "to is strictly higher than from", so this reads as:
    // reaching an acting route is a promotion from every read on the controller.
    const notBelowTheActingRoutes = handlers
      .filter(({ name }) => !ACTING_ROUTES.includes(name))
      .filter(({ capability }) => capability == null || !isCapabilityPromotion(capability, FULL_CAPABILITY))
      .map(({ name }) => name);

    expect(notBelowTheActingRoutes).toEqual([]);
  });
});
