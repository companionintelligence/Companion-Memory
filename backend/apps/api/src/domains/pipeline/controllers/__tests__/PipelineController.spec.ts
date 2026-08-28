import { ConflictException, NotFoundException, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import {
  READ_CAPABILITY,
  REQUIRE_CAPABILITY_KEY,
  REQUIRE_SCOPES_KEY,
  WRITE_CAPABILITY,
} from '@ci/common/decorators';
import { IdFormatGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { type DeadLetterBulkReplayResult, PipelineRunService } from '../../services/PipelineRunService';
import { PipelineStateService, type ReleaseQuarantinedInput } from '../../services/PipelineStateService';
import { PipelineController } from '../PipelineController';

/**
 * The operator surface, driven through a real Nest HTTP stack.
 *
 * Everything interesting about a controller lives in its wiring — the route
 * paths, the guards, the query parsing, and which exception maps to which status
 * — and none of that is exercised by calling the methods directly. So the tests
 * below go through `supertest` against a module containing this controller, a
 * `PipelineRunService` double, and the one global guard that matters
 * (`IdFormatGuard`, registered as `APP_GUARD` in `application.ts`).
 *
 * `JwtOrApiKeyAuthGuard` is overridden to always pass: whether a request is
 * authenticated is that guard's contract and it has its own tests. What IS
 * asserted here is the metadata the guard reads — every route's required
 * capability, and the deliberate ABSENCE of `@RequireScopes` — because those are
 * declarations this file owns and a missing one fails open.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const RUN_ID = '00000000-0000-7000-8000-0000000000c1';
const LETTER_ID = '00000000-0000-7000-8000-0000000000d1';

class AlwaysAllowGuard {
  canActivate = () => true;
}

function makeService() {
  return {
    stageState: jest.fn(async () => [
      {
        stage: 'enrich.media_dimensions',
        stageVersion: 1,
        total: 10,
        done: 8,
        skipped: 1,
        failed: 1,
        pending: 0,
        running: 0,
        quarantined: 0,
        stale: 2,
        coverage: 0.9,
      },
    ]),
    listRuns: jest.fn(async () => []),
    getRun: jest.fn(async () => ({
      id: RUN_ID,
      kind: 'reprocess',
      desiredState: 'running' as const,
      status: 'running',
      startedAt: new Date('2026-08-09T10:00:00Z'),
      finishedAt: null,
      active: true,
      detail: {},
      shardCount: 1,
      shardsByStatus: { running: 1 },
      shards: [],
      shardsTruncated: false,
    })),
    setDesiredState: jest.fn(async () => ({
      id: RUN_ID,
      kind: 'reprocess',
      desiredState: 'paused' as const,
      status: 'running',
      startedAt: new Date('2026-08-09T10:00:00Z'),
      finishedAt: null,
      active: true,
      detail: {},
      shardCount: 0,
      shardsByStatus: {},
    })),
    listDeadLetters: jest.fn(async () => []),
    replayDeadLetter: jest.fn(async () => ({
      id: LETTER_ID,
      eventName: 'pipeline.slice',
      queue: 'pipeline-enrich',
      jobIds: ['job-1'],
      replayedAt: new Date('2026-08-09T12:00:00Z'),
    })),
    replayDeadLetters: jest.fn(
      async (): Promise<DeadLetterBulkReplayResult> => ({
        requested: 1,
        claimed: 1,
        limit: 50,
        replayed: [
          {
            id: LETTER_ID,
            eventName: 'infer.question.answer',
            queue: null,
            jobIds: ['job-1'],
            replayedAt: new Date('2026-08-18T12:00:00Z'),
          },
        ],
        failed: [],
        skipped: [],
        notAttempted: [],
      }),
    ),
  };
}

/**
 * The ledger, doubled. Only the one method this controller reaches for: the
 * quarantine release is a WRITE to `ci.pipeline_state`, and
 * `PipelineStateService` is the only thing allowed to make one.
 */
function makeStateService() {
  return {
    releaseQuarantined: jest.fn(async (_userId: string, input: ReleaseQuarantinedInput = {}) => ({
      released: 12_237,
      reasons: input.reasons != null ? [...input.reasons] : ['provider_unavailable', 'ollama_unreachable'],
      stage: input.stage ?? null,
    })),
  };
}

describe('PipelineController', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeService>;
  let stateService: ReturnType<typeof makeStateService>;

  beforeEach(async () => {
    service = makeService();
    stateService = makeStateService();

    const module = await Test.createTestingModule({
      controllers: [PipelineController],
      providers: [
        { provide: PipelineRunService, useValue: service },
        { provide: PipelineStateService, useValue: stateService },
        { provide: APP_GUARD, useClass: IdFormatGuard },
      ],
    })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useClass(AlwaysAllowGuard)
      .compile();

    app = module.createNestApplication();

    // Stands in for RequestContextMiddleware: `@Context()` reads the request
    // context out of AsyncLocalStorage, and `toServiceContext` 401s without a
    // userId in it.
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      ContextService.run({ traceId: 'test-trace', userId: USER }, () => next());
    });

    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // GET /pipeline/state
  // -------------------------------------------------------------------------

  describe('GET /pipeline/state', () => {
    it('answers "is my import finished?" per stage, scoped to the caller', async () => {
      const response = await request(app.getHttpServer()).get('/pipeline/state').expect(200);

      expect(response.body.stages).toHaveLength(1);
      expect(response.body.stages[0]).toMatchObject({
        stage: 'enrich.media_dimensions',
        stageVersion: 1,
        done: 8,
        skipped: 1,
        failed: 1,
        pending: 0,
        stale: 2,
      });
      expect(service.stageState).toHaveBeenCalledWith({ userId: USER });
    });
  });

  // -------------------------------------------------------------------------
  // GET /pipeline/runs
  // -------------------------------------------------------------------------

  describe('GET /pipeline/runs', () => {
    it('passes limit and offset through', async () => {
      await request(app.getHttpServer()).get('/pipeline/runs?limit=5&offset=10').expect(200);

      expect(service.listRuns).toHaveBeenCalledWith(
        { userId: USER },
        { limit: 5, offset: 10, activeOnly: undefined },
      );
    });

    it('reads ?activeOnly=false as FALSE', async () => {
      // The reason `queryBoolean` exists. `z.coerce.boolean()` is `Boolean(value)`,
      // and `Boolean('false')` is `true` — so the naive schema would filter to
      // active runs only when asked for the opposite. This is the assertion that
      // stops somebody "simplifying" it back.
      await request(app.getHttpServer()).get('/pipeline/runs?activeOnly=false').expect(200);

      expect(service.listRuns).toHaveBeenCalledWith(
        { userId: USER },
        expect.objectContaining({ activeOnly: false }),
      );
    });

    it('reads ?activeOnly=true as TRUE', async () => {
      await request(app.getHttpServer()).get('/pipeline/runs?activeOnly=true').expect(200);

      expect(service.listRuns).toHaveBeenCalledWith(
        { userId: USER },
        expect.objectContaining({ activeOnly: true }),
      );
    });

    it('400s a limit outside the accepted range instead of clamping silently', async () => {
      await request(app.getHttpServer()).get('/pipeline/runs?limit=0').expect(400);
      await request(app.getHttpServer()).get('/pipeline/runs?limit=100000').expect(400);

      expect(service.listRuns).not.toHaveBeenCalled();
    });

    it('400s a boolean it cannot read rather than guessing', async () => {
      await request(app.getHttpServer()).get('/pipeline/runs?activeOnly=yes').expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // GET /pipeline/runs/:id
  // -------------------------------------------------------------------------

  describe('GET /pipeline/runs/:id', () => {
    it('returns the run with its shard progress', async () => {
      const response = await request(app.getHttpServer()).get(`/pipeline/runs/${RUN_ID}`).expect(200);

      expect(response.body).toMatchObject({ id: RUN_ID, active: true, shardCount: 1 });
      expect(service.getRun).toHaveBeenCalledWith({ userId: USER }, RUN_ID);
    });

    it('404s a malformed id before it reaches a ::uuid cast', async () => {
      // IdFormatGuard is a global APP_GUARD, which is why this controller does
      // not validate `:id` itself.
      await request(app.getHttpServer()).get('/pipeline/runs/not-a-uuid').expect(404);

      expect(service.getRun).not.toHaveBeenCalled();
    });

    it('surfaces the service 404 as a 404', async () => {
      service.getRun.mockRejectedValueOnce(new NotFoundException('nope'));

      await request(app.getHttpServer()).get(`/pipeline/runs/${RUN_ID}`).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  describe('run control', () => {
    it.each([
      ['pause', 'paused'],
      ['resume', 'running'],
      ['cancel', 'cancelled'],
    ])('POST /runs/:id/%s writes desired_state %s', async (action, desired) => {
      // 200, not 201: these create nothing. They record an intent a worker
      // reconciles toward between batches.
      await request(app.getHttpServer()).post(`/pipeline/runs/${RUN_ID}/${action}`).expect(200);

      expect(service.setDesiredState).toHaveBeenCalledWith({ userId: USER }, RUN_ID, desired);
    });

    it('409s when the run can no longer accept control changes', async () => {
      service.setDesiredState.mockRejectedValueOnce(new ConflictException('already finished'));

      await request(app.getHttpServer()).post(`/pipeline/runs/${RUN_ID}/pause`).expect(409);
    });

    it('404s an unknown run', async () => {
      service.setDesiredState.mockRejectedValueOnce(new NotFoundException('nope'));

      await request(app.getHttpServer()).post(`/pipeline/runs/${RUN_ID}/cancel`).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // Dead letters
  // -------------------------------------------------------------------------

  describe('GET /pipeline/dead-letters', () => {
    it('passes the queue, stage and replayed filters through', async () => {
      await request(app.getHttpServer())
        .get('/pipeline/dead-letters?queue=pipeline-embed&stage=index.embed&replayed=false&limit=10')
        .expect(200);

      expect(service.listDeadLetters).toHaveBeenCalledWith(
        { userId: USER },
        { queue: 'pipeline-embed', stage: 'index.embed', replayed: false, limit: 10, offset: undefined },
      );
    });

    it('defaults every filter to absent', async () => {
      await request(app.getHttpServer()).get('/pipeline/dead-letters').expect(200);

      expect(service.listDeadLetters).toHaveBeenCalledWith(
        { userId: USER },
        { queue: undefined, stage: undefined, replayed: undefined, limit: undefined, offset: undefined },
      );
    });

    it('400s a page larger than the ceiling', async () => {
      // Small on purpose: every row carries its payload verbatim and its full
      // error with stack.
      await request(app.getHttpServer()).get('/pipeline/dead-letters?limit=201').expect(400);
    });
  });

  describe('POST /pipeline/dead-letters/:id/replay', () => {
    it('reports what was re-emitted', async () => {
      const response = await request(app.getHttpServer())
        .post(`/pipeline/dead-letters/${LETTER_ID}/replay`)
        .expect(200);

      expect(response.body).toMatchObject({
        id: LETTER_ID,
        eventName: 'pipeline.slice',
        queue: 'pipeline-enrich',
        jobIds: ['job-1'],
      });
      expect(service.replayDeadLetter).toHaveBeenCalledWith({ userId: USER }, LETTER_ID);
    });

    it('409s a letter that was already replayed', async () => {
      service.replayDeadLetter.mockRejectedValueOnce(new ConflictException('already replayed'));

      await request(app.getHttpServer()).post(`/pipeline/dead-letters/${LETTER_ID}/replay`).expect(409);
    });

    it('404s a malformed letter id', async () => {
      await request(app.getHttpServer()).post('/pipeline/dead-letters/nope/replay').expect(404);

      expect(service.replayDeadLetter).not.toHaveBeenCalled();
    });
  });

  describe('POST /pipeline/dead-letters/replay', () => {
    const LETTER_2 = '00000000-0000-7000-8000-0000000000d2';

    it('passes an explicit id batch through', async () => {
      const response = await request(app.getHttpServer())
        .post('/pipeline/dead-letters/replay')
        .send({ ids: [LETTER_ID, LETTER_2] })
        .expect(200);

      expect(service.replayDeadLetters).toHaveBeenCalledWith(
        { userId: USER },
        { ids: [LETTER_ID, LETTER_2], eventName: undefined, failedAfter: undefined, limit: undefined },
      );
      expect(response.body.replayed).toHaveLength(1);
    });

    it('passes the failure-class selector through, with failedAfter parsed as a date', async () => {
      await request(app.getHttpServer())
        .post('/pipeline/dead-letters/replay')
        .send({ eventName: 'infer.question.answer', failedAfter: '2026-08-18T00:00:00.000Z', limit: 25 })
        .expect(200);

      expect(service.replayDeadLetters).toHaveBeenCalledWith(
        { userId: USER },
        {
          ids: undefined,
          eventName: 'infer.question.answer',
          failedAfter: new Date('2026-08-18T00:00:00.000Z'),
          limit: 25,
        },
      );
    });

    it('400s an empty selector rather than replaying everything', async () => {
      // The safety property of the whole endpoint: most of a real backlog is one
      // config error, and blind replay re-runs it against the same broken config.
      await request(app.getHttpServer()).post('/pipeline/dead-letters/replay').send({}).expect(400);

      expect(service.replayDeadLetters).not.toHaveBeenCalled();
    });

    it('400s a failedAfter it cannot read, instead of widening the selector to everything', async () => {
      // `z.coerce.date()` alone yields an Invalid Date here, which would bind as
      // NULL — i.e. no filter at all.
      await request(app.getHttpServer())
        .post('/pipeline/dead-letters/replay')
        .send({ failedAfter: 'not-a-date' })
        .expect(400);

      expect(service.replayDeadLetters).not.toHaveBeenCalled();
    });

    it('400s a malformed id in the batch before it reaches a ::uuid cast', async () => {
      // The single-id route gets this from IdFormatGuard; a body array is the
      // schema's job.
      await request(app.getHttpServer())
        .post('/pipeline/dead-letters/replay')
        .send({ ids: [LETTER_ID, 'not-a-uuid'] })
        .expect(400);

      expect(service.replayDeadLetters).not.toHaveBeenCalled();
    });

    it('400s a batch larger than the page ceiling', async () => {
      const ids = Array.from(
        { length: 201 },
        (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      );

      await request(app.getHttpServer()).post('/pipeline/dead-letters/replay').send({ ids }).expect(400);
    });

    it('reports partial failure as 200 with a body, not as a 500', async () => {
      // Some letters replayed and some did not is the NORMAL outcome of a batch.
      // Failing the call would hide the ones that went back on the bus.
      service.replayDeadLetters.mockResolvedValueOnce({
        requested: 2,
        claimed: 2,
        limit: 50,
        replayed: [
          {
            id: LETTER_ID,
            eventName: 'infer.question.answer',
            queue: null,
            jobIds: ['job-1'],
            replayedAt: new Date('2026-08-18T12:00:00Z'),
          },
        ],
        failed: [{ id: LETTER_2, eventName: 'infer.question.answer', reason: 'pg-boss is down' }],
        skipped: [],
        notAttempted: [],
      });

      const response = await request(app.getHttpServer())
        .post('/pipeline/dead-letters/replay')
        .send({ ids: [LETTER_ID, LETTER_2] })
        .expect(200);

      expect(response.body.replayed).toHaveLength(1);
      expect(response.body.failed[0]).toMatchObject({ id: LETTER_2, reason: 'pg-boss is down' });
    });

    it('reports an already-replayed double submit as skipped, at 200', async () => {
      // The claim guard lives in SQL. A second submit claims nothing, and that is
      // a normal answer — not a 409 that would hide the rest of the batch.
      service.replayDeadLetters.mockResolvedValueOnce({
        requested: 2,
        claimed: 0,
        limit: 50,
        replayed: [],
        failed: [],
        skipped: [LETTER_ID, LETTER_2],
        notAttempted: [],
      });

      const response = await request(app.getHttpServer())
        .post('/pipeline/dead-letters/replay')
        .send({ ids: [LETTER_ID, LETTER_2] })
        .expect(200);

      expect(response.body).toMatchObject({ claimed: 0, skipped: [LETTER_ID, LETTER_2] });
    });
  });

  // -------------------------------------------------------------------------
  // POST /pipeline/quarantine/release
  // -------------------------------------------------------------------------

  describe('POST /pipeline/quarantine/release', () => {
    it('releases the declared transient reasons when the body names none', async () => {
      // The default is the whole point of the route being usable at all: an
      // operator who has just read "12,237 quarantined: provider_unavailable"
      // should not have to know the token to undo it.
      const response = await request(app.getHttpServer())
        .post('/pipeline/quarantine/release')
        .send({})
        .expect(200);

      expect(stateService.releaseQuarantined).toHaveBeenCalledWith(USER, {
        reasons: undefined,
        stage: undefined,
      });
      expect(response.body).toMatchObject({
        released: 12_237,
        reasons: ['provider_unavailable', 'ollama_unreachable'],
        stage: null,
      });
    });

    it('passes an explicit reason and stage selector through', async () => {
      await request(app.getHttpServer())
        .post('/pipeline/quarantine/release')
        .send({ reasons: ['provider_status_unrecognized'], stage: 'enrich.position_reverse' })
        .expect(200);

      expect(stateService.releaseQuarantined).toHaveBeenCalledWith(USER, {
        reasons: ['provider_status_unrecognized'],
        stage: 'enrich.position_reverse',
      });
    });

    it('400s an explicitly empty reason list rather than treating it as "all"', async () => {
      // `{}` means the declared transient set; `{ reasons: [] }` means the
      // caller tried to name reasons and named none, which is a different
      // mistake and must not silently widen to every quarantined row.
      await request(app.getHttpServer())
        .post('/pipeline/quarantine/release')
        .send({ reasons: [] })
        .expect(400);

      expect(stateService.releaseQuarantined).not.toHaveBeenCalled();
    });

    it('is scoped to the caller, never to a user id in the body', async () => {
      await request(app.getHttpServer())
        .post('/pipeline/quarantine/release')
        .send({ userId: '00000000-0000-4000-8000-0000000000bb' })
        .expect(200);

      expect(stateService.releaseQuarantined).toHaveBeenCalledWith(USER, expect.anything());
    });
  });

  // -------------------------------------------------------------------------
  // Auth declarations
  //
  // These are metadata assertions rather than request assertions because the
  // guard that reads them is overridden above. They still belong here: the
  // declarations are this file's, and every one of them fails OPEN if forgotten.
  // -------------------------------------------------------------------------

  describe('auth declarations', () => {
    const handler = (name: keyof PipelineController) =>
      PipelineController.prototype[name] as unknown as object;

    it('guards the whole controller with JwtOrApiKeyAuthGuard', () => {
      const guards = Reflect.getMetadata('__guards__', PipelineController) as unknown[];

      expect(guards).toContain(JwtOrApiKeyAuthGuard);
    });

    it.each(['getState', 'listRuns', 'getRun', 'listDeadLetters'] as const)(
      '%s requires only read capability',
      (name) => {
        expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, handler(name))).toBe(READ_CAPABILITY);
      },
    );

    it.each([
      'pauseRun',
      'resumeRun',
      'cancelRun',
      'replayDeadLetter',
      'replayDeadLetters',
      'releaseQuarantine',
    ] as const)('%s requires write capability, so a read-only key cannot steer a run', (name) => {
      expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, handler(name))).toBe(WRITE_CAPABILITY);
    });

    it('declares no scopes, so a scope-limited api key cannot reach the control plane', () => {
      // Scope enforcement is deny-by-default: a scope-limited key is confined to
      // routes that explicitly grant one of its scopes, and this controller
      // grants none. Adding @RequireScopes here would OPEN it up, not lock it
      // down — which is the opposite of what the decorator's name suggests.
      expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, PipelineController)).toBeUndefined();

      for (const name of [
        'getState',
        'listRuns',
        'getRun',
        'pauseRun',
        'resumeRun',
        'cancelRun',
        'listDeadLetters',
        'replayDeadLetter',
        'replayDeadLetters',
        'releaseQuarantine',
      ] as const) {
        expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, handler(name))).toBeUndefined();
      }
    });
  });
});
