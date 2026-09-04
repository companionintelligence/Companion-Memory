import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { FULL_CAPABILITY, REQUIRE_CAPABILITY_KEY, REQUIRE_SCOPES_KEY, WRITE_CAPABILITY } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

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
    })),
  };
}

async function buildApp(
  guard: unknown,
  monitor: ReturnType<typeof makeMonitorService>,
  query: ReturnType<typeof makeQueryService> = makeQueryService(),
) {
  const module = await Test.createTestingModule({
    controllers: [JobsController],
    providers: [
      { provide: JobMonitorService, useValue: monitor },
      { provide: JobQueryService, useValue: query },
      { provide: JobControlsService, useValue: {} },
    ],
  })
    .overrideGuard(JwtOrApiKeyAuthGuard)
    .useClass(guard as new () => unknown)
    .compile();

  const app = module.createNestApplication();

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

  it('forwards the scope when authenticated', async () => {
    app = await buildApp(AlwaysAllowGuard, makeMonitorService(), query);

    const response = await request(app.getHttpServer())
      .post('/jobs/clear')
      .send({ scope: 'failed' })
      .expect(201);

    expect(response.body).toEqual({ scope: 'failed', deleted: 3 });
    expect(query.clearTerminal).toHaveBeenCalledWith(expect.anything(), 'failed');
  });

  describe('auth declarations', () => {
    const handler = JobsController.prototype.clearTerminal as unknown as object;

    it('is guarded by JwtOrApiKeyAuthGuard', () => {
      const guards = Reflect.getMetadata('__guards__', handler) as unknown[] | undefined;

      expect(guards).toContain(JwtOrApiKeyAuthGuard);
    });

    it('requires WRITE capability — irreversible, but only for already-stopped work', () => {
      expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, handler)).toBe(WRITE_CAPABILITY);
    });
  });
});
