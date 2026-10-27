import { ForbiddenException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import { FULL_CAPABILITY, REQUIRE_CAPABILITY_KEY, REQUIRE_SCOPES_KEY } from '@ci/common/decorators';
import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MAX_CONCURRENCY } from '@ci/common/job-controls';

import { EventListenerRegistry } from '../../event-registration';
import { JobControlsService } from '../../services/JobControlsService';
import { JobMonitorService } from '../../services/JobMonitorService';
import { JobQueryService } from '../../services/JobQueryService';
import { JobsController } from '../JobsController';

/**
 * `POST /jobs/crons/run`, the one route on this controller that ACTS rather than
 * reports: it fans out over every `@Cron` the process has registered and fires
 * each one the way the scheduler would.
 *
 * These tests exist because the route shipped with no auth guard at all. Its only
 * protection was a loopback check on `request.socket.remoteAddress` — the
 * IMMEDIATE PEER, not the client — so both proxies this repo ships (the `make dev`
 * Caddy route, and the Vite dev server's `/api` proxy, which binds `0.0.0.0`)
 * made every request on the network look local. Among the crons reachable that
 * way is `AccountPurgeCron.purgeDueAccounts`, which permanently deletes accounts.
 *
 * The rejection test below is deliberately routed through a real HTTP stack
 * rather than asserted as metadata, and that is what makes it a regression test
 * rather than a restatement: supertest connects over loopback, so against the old
 * code an unauthenticated call did not merely slip past the guard — it satisfied
 * `isLoopback` and returned **201 Created**, firing every cron on the box.
 */

const CRON_NAME = 'AccountPurgeCron.purgeDueAccounts';

/** Stands in for the real guard's verdict on a request carrying no credentials. */
class DenyUnauthenticatedGuard {
  canActivate(): boolean {
    throw new UnauthorizedException();
  }
}

class AlwaysAllowGuard {
  canActivate = () => true;
}

function makeMonitorService() {
  return {
    getDashboard: jest.fn(async () => ({})),
    fireCronJobs: jest.fn(() => ({ fired: [CRON_NAME], skipped: [], errors: [] })),
  };
}

function makeQueryService() {
  return {
    clearTerminal: jest.fn(async (_context: unknown, scope: 'dead-letter' | 'failed') => ({
      scope,
      deleted: 3,
      retained: scope === 'dead-letter' ? 7 : 0,
    })),
  };
}

/** Stands in for {@link ApplianceAdminGuard} on an appliance that has an admin. */
class DenyNonAdminGuard {
  canActivate(): boolean {
    throw new ForbiddenException('This action requires an administrator account');
  }
}

async function buildApp(
  guard: unknown,
  monitor: ReturnType<typeof makeMonitorService>,
  query: ReturnType<typeof makeQueryService> = makeQueryService(),
  adminGuard: unknown = AlwaysAllowGuard,
  controls: unknown = {},
) {
  const module = await Test.createTestingModule({
    controllers: [JobsController],
    providers: [
      { provide: JobMonitorService, useValue: monitor },
      { provide: JobQueryService, useValue: query },
      { provide: JobControlsService, useValue: controls },
    ],
  })
    .overrideGuard(JwtOrApiKeyAuthGuard)
    .useClass(guard as new () => unknown)
    // Overridden rather than provided: the real guard takes a DataSource, and
    // what these cases assert is that the controller CONSULTS a principal check,
    // not how that check answers. `ApplianceAdminGuard.test.ts` owns the verdict.
    .overrideGuard(ApplianceAdminGuard)
    .useClass(adminGuard as new () => unknown)
    .compile();

  const app = module.createNestApplication();

  // Stands in for RequestContextMiddleware: `@Context()` reads the request
  // context out of AsyncLocalStorage, so a handler that takes one 500s with
  // "Request context not found" without it. When it was missing, only
  // `POST /jobs/clear` reached a handler body (every other case was answered by
  // a guard or read straight off route metadata), which is why the omission
  // surfaced as one failing test rather than a whole red file. The
  // `PUT /jobs/controls` range cases reach `updateControls` as well, which reads
  // `context.userId` before the service refuses the body.
  app.use((_req: unknown, _res: unknown, next: () => void) => {
    ContextService.run({ traceId: 'test-trace', userId: 'user-1' }, () => next());
  });

  await app.init();

  return app;
}

describe('POST /jobs/crons/run', () => {
  let app: INestApplication;
  let monitor: ReturnType<typeof makeMonitorService>;

  beforeEach(() => {
    monitor = makeMonitorService();
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('unauthenticated', () => {
    beforeEach(async () => {
      app = await buildApp(DenyUnauthenticatedGuard, monitor);
    });

    it('rejects a call that carries no credentials, from loopback', async () => {
      // Supertest's own connection IS loopback — the exact shape a reverse proxy
      // presents to the API, and the one the removed check could not tell apart
      // from an operator inside the container.
      await request(app.getHttpServer()).post('/jobs/crons/run').expect(401);

      expect(monitor.fireCronJobs).not.toHaveBeenCalled();
    });

    it('rejects a named single cron too, not just the fire-everything form', async () => {
      await request(app.getHttpServer())
        .post(`/jobs/crons/run?name=${encodeURIComponent(CRON_NAME)}`)
        .expect(401);

      expect(monitor.fireCronJobs).not.toHaveBeenCalled();
    });

    it('cannot be talked past with a forged X-Forwarded-For', async () => {
      // The header the "make the check honest" fix would have had to trust.
      // `express` runs `trust proxy = 1`, so on a direct connection this value
      // is attacker-controlled — which is why authentication, not network
      // location, is the control.
      await request(app.getHttpServer())
        .post('/jobs/crons/run')
        .set('X-Forwarded-For', '127.0.0.1')
        .expect(401);

      expect(monitor.fireCronJobs).not.toHaveBeenCalled();
    });
  });

  describe('authenticated', () => {
    beforeEach(async () => {
      app = await buildApp(AlwaysAllowGuard, monitor);
    });

    it('fires every registered cron when no name is given', async () => {
      const response = await request(app.getHttpServer()).post('/jobs/crons/run').expect(201);

      expect(monitor.fireCronJobs).toHaveBeenCalledWith(undefined);
      expect(response.body).toMatchObject({ fired: [CRON_NAME], skipped: [], errors: [] });
    });

    it('fires only the named cron, trimmed', async () => {
      await request(app.getHttpServer())
        .post(`/jobs/crons/run?name=${encodeURIComponent(` ${CRON_NAME} `)}`)
        .expect(201);

      expect(monitor.fireCronJobs).toHaveBeenCalledWith([CRON_NAME]);
    });

    it('reads a blank name as "fire everything" rather than as a cron called ""', async () => {
      await request(app.getHttpServer()).post('/jobs/crons/run?name=%20%20').expect(201);

      expect(monitor.fireCronJobs).toHaveBeenCalledWith(undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // Auth declarations
  //
  // Metadata assertions, because the guard that reads them is overridden above.
  // They belong here all the same: each one fails OPEN if dropped, which is
  // exactly how this route came to be unguarded.
  // ---------------------------------------------------------------------------

  describe('auth declarations', () => {
    const handler = JobsController.prototype.runCrons as unknown as object;

    it('is guarded by JwtOrApiKeyAuthGuard', () => {
      const guards = Reflect.getMetadata('__guards__', handler) as unknown[] | undefined;

      expect(guards).toContain(JwtOrApiKeyAuthGuard);
    });

    it('requires FULL capability, since the set it fires includes a purge', () => {
      // `write` is defined as "mutating, but nothing that deletes", and this
      // route can fire AccountPurgeCron. The capability has to cover the widest
      // thing reachable through it, not the average one.
      expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, handler)).toBe(FULL_CAPABILITY);
    });

    it('declares no scopes, so a scope-limited api key cannot reach it at all', () => {
      // Scope enforcement is deny-by-default: adding @RequireScopes here would
      // OPEN the route to scoped keys, not confine it.
      expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, JobsController)).toBeUndefined();
    });
  });
});

describe('POST /jobs/clear', () => {
  let app: INestApplication;
  let query: ReturnType<typeof makeQueryService>;

  beforeEach(() => {
    query = makeQueryService();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('rejects an unauthenticated call', async () => {
    app = await buildApp(DenyUnauthenticatedGuard, makeMonitorService(), query);

    await request(app.getHttpServer()).post('/jobs/clear').send({ scope: 'dead-letter' }).expect(401);
    expect(query.clearTerminal).not.toHaveBeenCalled();
  });

  it('rejects a signed-in NON-ADMIN on an appliance that has an admin', async () => {
    // The hole this route shipped with, and the one `@RequireCapability` could
    // never have closed: `enforceApiKeyCapability` returns early for a session
    // principal, so the decorator said nothing about the Jobs page open in any
    // household member's browser. Routed through a real HTTP stack rather than
    // asserted as metadata — the point is that the request is REFUSED, not that
    // a decorator is present.
    app = await buildApp(AlwaysAllowGuard, makeMonitorService(), query, DenyNonAdminGuard);

    await request(app.getHttpServer()).post('/jobs/clear').send({ scope: 'dead-letter' }).expect(403);

    expect(query.clearTerminal).not.toHaveBeenCalled();
  });

  it('forwards the scope when authenticated', async () => {
    app = await buildApp(AlwaysAllowGuard, makeMonitorService(), query);

    const response = await request(app.getHttpServer())
      .post('/jobs/clear')
      .send({ scope: 'failed' })
      .expect(201);

    expect(response.body).toEqual({ scope: 'failed', deleted: 3, retained: 0 });
    expect(query.clearTerminal).toHaveBeenCalledWith(expect.anything(), 'failed');
  });

  it('passes `retained` through, so the page can say what it kept', async () => {
    // The dead-letter scope deliberately leaves unharvested letters behind, so
    // the count on screen does not reach zero. Swallowing that number here is
    // what would make a working, conservative delete read as a broken button.
    app = await buildApp(AlwaysAllowGuard, makeMonitorService(), query);

    const response = await request(app.getHttpServer())
      .post('/jobs/clear')
      .send({ scope: 'dead-letter' })
      .expect(201);

    expect(response.body).toEqual({ scope: 'dead-letter', deleted: 3, retained: 7 });
  });

  describe('auth declarations', () => {
    const handler = JobsController.prototype.clearTerminal as unknown as object;

    it('is guarded by JwtOrApiKeyAuthGuard', () => {
      const guards = Reflect.getMetadata('__guards__', handler) as unknown[] | undefined;

      expect(guards).toContain(JwtOrApiKeyAuthGuard);
    });

    it('requires FULL capability, because it DELETES', () => {
      // `write` is defined in ApiKeyCapability.ts as "read + mutating tools, but
      // nothing that deletes", and it is also DEFAULT_API_KEY_CAPABILITY — the
      // level every new key is minted at. Shipping a hard DELETE on `write` put
      // the appliance's broadest, least-considered grant on the one button that
      // destroys rows. Fails OPEN if dropped, which is why it is pinned.
      expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, handler)).toBe(FULL_CAPABILITY);
    });

    it('is guarded by ApplianceAdminGuard as well, for the principals capability cannot see', () => {
      const guards = Reflect.getMetadata('__guards__', handler) as unknown[] | undefined;

      expect(guards).toContain(ApplianceAdminGuard);
    });
  });
});

/**
 * `PUT /jobs/controls` with a concurrency out of range. The Jobs page shows the
 * 400's `message` and nothing else, so the reason has to be in it: the route's
 * zod pipe used to refuse 100 as a bare "Validation failed" before
 * `JobControlsService.checkConcurrency` could say what the range is.
 */
describe('PUT /jobs/controls', () => {
  let app: INestApplication;
  let repository: { query: jest.Mock };

  beforeEach(async () => {
    // One real queue, so a queue's own cap is checked for range instead of
    // being refused first as an unknown queue.
    EventListenerRegistry.clear();
    EventListenerRegistry.register(
      'file.uploaded',
      'ImageDescriptionListener',
      'describe',
      'image-description',
    );
    repository = { query: jest.fn() };
    app = await buildApp(
      AlwaysAllowGuard,
      makeMonitorService(),
      makeQueryService(),
      AlwaysAllowGuard,
      new JobControlsService(repository as never),
    );
  });

  afterEach(async () => {
    await app?.close();
    EventListenerRegistry.clear();
  });

  it.each([
    ['100 for the whole appliance', { global: { concurrency: 100 } }],
    ['0 for the per-queue default', { global: { perQueueConcurrency: 0 } }],
    ['2.5 for the whole appliance', { global: { concurrency: 2.5 } }],
    ['100 for one queue', { queues: [{ name: 'image-description', concurrency: 100 }] }],
  ])(`explains the 1 to ${MAX_CONCURRENCY} range when given %s and writes nothing`, async (_label, body) => {
    const response = await request(app.getHttpServer()).put('/jobs/controls').send(body).expect(400);

    expect(response.body.message).toMatch(
      new RegExp(`^Concurrency must be a whole number between 1 and ${MAX_CONCURRENCY}\\.`),
    );
    expect(repository.query).not.toHaveBeenCalled();
  });

  it('names the field it refused, since the pipe no longer reports a path', async () => {
    const response = await request(app.getHttpServer())
      .put('/jobs/controls')
      .send({ global: { concurrency: 4, perQueueConcurrency: 100 } })
      .expect(400);

    expect(response.body.message).toContain('The per-queue default was given 100.');
    expect(repository.query).not.toHaveBeenCalled();
  });

  it('still refuses a concurrency that is not a number at the pipe', async () => {
    const response = await request(app.getHttpServer())
      .put('/jobs/controls')
      .send({ global: { concurrency: 'lots' } })
      .expect(400);

    expect(response.body.message).toBe('Validation failed');
    expect(repository.query).not.toHaveBeenCalled();
  });
});

/**
 * The rest of the appliance-wide control plane.
 *
 * `clear` is not special — `crons/run` fires every schedule on the box
 * (including an account purge) and `PUT /controls` can pause the memory system
 * for everyone. All three carried a `@RequireCapability` that is a no-op for
 * sessions, so all three need the principal check, and asserting it on one of
 * them would leave the other two to be re-litigated later.
 */
describe('the appliance-wide control plane declares BOTH axes', () => {
  const ROUTES: ReadonlyArray<[name: string, handler: unknown]> = [
    ['clearTerminal', JobsController.prototype.clearTerminal],
    ['runCrons', JobsController.prototype.runCrons],
    ['updateControls', JobsController.prototype.updateControls],
  ];

  it.each(ROUTES)('%s is guarded by ApplianceAdminGuard', (_name, handler) => {
    const guards = Reflect.getMetadata('__guards__', handler as object) as unknown[] | undefined;

    expect(guards).toContain(JwtOrApiKeyAuthGuard);
    expect(guards).toContain(ApplianceAdminGuard);
  });

  it.each(ROUTES)('%s still states a capability, for api-key principals', (_name, handler) => {
    // The guard does not replace the capability axis. A `write` key belonging to
    // an admin still must not reach a delete, and on an appliance with no admin
    // the capability is the only control left standing.
    expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, handler as object)).toBeDefined();
  });

  it('does not admin-gate the READ routes, which the page needs to render', () => {
    // A dashboard nobody can open is not a security improvement. Only the three
    // routes that ACT are gated.
    for (const handler of [
      JobsController.prototype.getDashboard,
      JobsController.prototype.list,
      JobsController.prototype.history,
      JobsController.prototype.controls,
      JobsController.prototype.types,
    ]) {
      const guards = Reflect.getMetadata('__guards__', handler as unknown as object) as unknown[] | undefined;

      expect(guards).not.toContain(ApplianceAdminGuard);
    }
  });
});
