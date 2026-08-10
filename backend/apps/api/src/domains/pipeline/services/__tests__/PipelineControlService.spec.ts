import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../__tests__/harness/pipelineHarness';
import { SHARD_LEASE_SECONDS, STAGE_IDS, STAGE_ID_LIST, type StageId } from '../../constants';
import { automaticStageIds, stageDueness, stageSchedule } from '../../schedule';
import type { Stage } from '../../types';
import type { EnrichmentWindowService } from '../EnrichmentWindowService';
import {
  CONTINUOUS_RUN_KIND,
  MAX_SWEEPS_PER_TICK,
  METERED_STAGES,
  PipelineControlService,
  SHARD_STATUS,
  STAGE_DEPENDENCIES,
  assertStagePolicy,
  defaultStageSet,
  isMeteredStage,
  orderStages,
  type StageLeg,
} from '../PipelineControlService';
import type { PipelineDispatchService } from '../PipelineDispatchService';
import type { PipelineRunService } from '../PipelineRunService';
import type { PipelineStateService } from '../PipelineStateService';
import type { StageRegistry } from '../StageRegistry';

/**
 * The control tick is the answer to a specific, measured absence: twelve stages
 * resolved, `startSweep()` worked, `PipelineSliceListener` executed slices — and
 * NOTHING CALLED ANY OF IT. No cron, no scheduled caller, no route.
 * `ci.pipeline_runs` had never held a row and `SHARD_LEASE_SECONDS` was declared
 * and unused. So the properties under test here are not "the tick runs"; they are
 * the five ways a control loop over this schema silently ruins an appliance:
 *
 *  1. **A cancelled run that nobody finalises is a permanent lockout.**
 *     `pipeline_runs_active_uniq` is a partial unique index on `(user_id) WHERE
 *     finished_at IS NULL`, and cancel writes only `desired_state`. Every test
 *     about cancellation is really a test that `finishRun` was called.
 *  2. **A sweep that finds nothing is not free**, and there are twelve stages
 *     multiplied by every tick, forever.
 *  3. **A consumer run ahead of its producer writes a corpus of skips** that
 *     only a version bump can re-open.
 *  4. **An expired shard lease strands a leg forever**, because the claim refuses
 *     a leg it believes somebody is inside.
 *  5. **A metered stage started by a timer is a recurring bill.**
 *     `enrich.geocode` and `enrich.position_reverse` egress to a paid provider.
 *
 * ## Two halves, because the behaviour lives in two places
 *
 * **Against fakes** — the decisions: what the tick reads, what it refuses to
 * start, the order it starts things in, and that a failure anywhere never
 * escapes the cron. Fast, hermetic, always runs.
 *
 * **Against real Postgres** — the two statements whose semantics are ENTIRELY in
 * SQL: the shard-lease reap and the `ON CONFLICT ... WHERE` claim. Whether a live
 * lease actually refuses a second claimant, whether `done` is re-claimable (it
 * must be — see the wedge argument on `UNCLAIMABLE_SHARD_STATUSES`), and whether
 * the reaper leaves terminal shards alone are not observable from a mock, because
 * a mock agrees with whatever the statement asks it.
 *
 * ## How the database half stays out of the dev data
 *
 * Same discipline as `DeadLetterReaperListener.spec`: the service is handed a
 * `DataSource` double funnelling every statement into ONE `QueryRunner` inside a
 * transaction that is **always rolled back**. Nothing is committed — not the
 * synthetic run, not its shards — so no other session can observe them, there is
 * nothing to clean up, and a `kill -9` mid-run leaves the live appliance's
 * 324,044 events untouched.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[PipelineControlService.spec] SKIPPED (database half) — ${availability.reason}`);
}

// ---------------------------------------------------------------------------
// Half one: the decisions, against fakes
// ---------------------------------------------------------------------------

/** One statement the tick issued, whitespace-collapsed and lowercased for matching. */
interface Statement {
  sql: string;
  params: unknown[];
}

/** A user row as {@link PipelineControlService} reads it, plus its active run. */
interface UserRow {
  user_id: string;
  run_id: string | null;
  kind: string | null;
  desired_state: string | null;
  detail: Record<string, unknown> | null;
}

interface ControlOptions {
  /** Whether `pg_try_advisory_lock` grants. An array is consumed one tick at a time. */
  lock?: boolean | boolean[];

  /** Whether the control-plane tables exist. */
  controlPlane?: boolean;

  users?: UserRow[];

  /** Stage legs with stale rows, as `stageId` or `stageId|entityType`. */
  stale?: string[];

  /**
   * `ci.pipeline_schedule` rows, as `stageId` or `stageId|entityType` → when
   * that leg last had a sweep started.
   *
   * A leg absent from this map has no row, which is `never_run` — infinite
   * staleness, and therefore due. That default is what keeps every test written
   * before the dueness gate meaning what it meant: on a fresh appliance every
   * leg is overdue, so the tick behaves exactly as it did when there was no
   * clock at all.
   */
  lastStartedAt?: Record<string, Date>;

  /** `WindowStatus.open`. Defaults to open, so a test opts in to the night. */
  windowOpen?: boolean;

  /** Make the window unreadable, the way an unmigrated `ci.pipeline_turns` is. */
  windowThrows?: boolean;

  /** Entity types per stage. Defaults to one type named `event`. */
  entityTypes?: Partial<Record<StageId, string[]>>;

  /** Shard leases the reap statement reclaims. */
  reaped?: number;

  /** Does any non-terminal shard of the run still hold a live lease? */
  liveLease?: boolean;

  /** Stage ids whose shard claim is refused — i.e. another tick owns the leg. */
  claimDenied?: string[];

  /** What `startRun` answers with. */
  startRun?: { id?: string; desiredState?: string; created?: boolean };

  /** Stage ids the registry cannot resolve. */
  unbound?: string[];

  /** Make the staleness probe throw for this user id. */
  probeThrowsForUser?: string;

  /** Make `startSweep` throw for these stage ids. */
  sweepThrows?: string[];

  /** Make any statement matching this throw, the way a dead connection would. */
  failOn?: RegExp;
}

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const RUN_A = '00000000-0000-4000-8000-0000000000c3';

/** A user with an active, running run. */
function runningRun(overrides: Partial<UserRow> = {}): UserRow {
  return {
    user_id: USER_A,
    run_id: RUN_A,
    kind: CONTINUOUS_RUN_KIND,
    desired_state: 'running',
    detail: {},
    ...overrides,
  };
}

/** A user with no active run at all. */
function noRun(overrides: Partial<UserRow> = {}): UserRow {
  return { user_id: USER_A, run_id: null, kind: null, desired_state: null, detail: null, ...overrides };
}

function makeControl(options: ControlOptions = {}) {
  const statements: Statement[] = [];
  const unlocks: number[] = [];
  const lockAnswers = Array.isArray(options.lock) ? [...options.lock] : null;
  const released: string[] = [];

  const record = (raw: string, params?: unknown[]): Statement => {
    const sql = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    const statement = { sql, params: params ?? [] };
    statements.push(statement);

    return statement;
  };

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const { sql } = record(raw, params);

    if (options.failOn != null && options.failOn.test(sql)) {
      throw new Error('connection terminated unexpectedly');
    }

    if (/to_regclass/.test(sql)) {
      return [{ present: options.controlPlane ?? true }];
    }

    // The lease reap. A CTE, not a bare UPDATE — see the test that pins why.
    if (sql.startsWith('with reaped as')) {
      return Array.from({ length: options.reaped ?? 0 }, () => ({ id: randomUUID() }));
    }

    // The cancellation tear-down: the only UPDATE scoped by `run_id`.
    if (sql.startsWith('update ci.pipeline_shards') && /where run_id/.test(sql)) {
      return [];
    }

    if (/from ci\.users/.test(sql)) {
      return options.users ?? [];
    }

    // The per-leg clock, read once per user per tick.
    if (/from ci\.pipeline_schedule/.test(sql)) {
      return Object.entries(options.lastStartedAt ?? {}).map(([leg, startedAt]) => {
        const [stage, entityType = 'event'] = leg.split('|');

        return { stage, entity_type: entityType, last_started_at: startedAt };
      });
    }

    // The stamp. Written on a successful claim, BEFORE the sweep is started.
    if (sql.startsWith('insert into ci.pipeline_schedule')) {
      return [];
    }

    // The claim and the drain are both upserts on the same table; only the claim
    // takes a lease, so `make_interval` is what tells them apart.
    if (sql.startsWith('insert into ci.pipeline_shards') && /make_interval/.test(sql)) {
      const stageId = String(params?.[1] ?? '');

      return (options.claimDenied ?? []).includes(stageId) ? [] : [{ id: randomUUID() }];
    }

    if (sql.startsWith('insert into ci.pipeline_shards')) {
      return [];
    }

    if (sql.startsWith('select s.id from ci.pipeline_shards')) {
      return (options.liveLease ?? false) ? [{ id: randomUUID() }] : [];
    }

    throw new Error(`PipelineControlService issued an unexpected statement: ${sql}`);
  });

  const runnerQuery = jest.fn(async (raw: string, params?: unknown[]) => {
    record(raw, params);

    if (/pg_try_advisory_lock/.test(raw)) {
      const granted = lockAnswers != null ? (lockAnswers.shift() ?? false) : (options.lock ?? true);

      return [{ locked: granted }];
    }

    if (/pg_advisory_unlock/.test(raw)) {
      unlocks.push(statements.length);

      return [{ pg_advisory_unlock: true }];
    }

    throw new Error(`PipelineControlService issued an unexpected runner statement: ${raw}`);
  });

  const dataSource = {
    query,
    createQueryRunner: jest.fn(() => ({
      connect: jest.fn(async () => undefined),
      query: runnerQuery,
      release: jest.fn(async () => {
        released.push('released');
      }),
    })),
  };

  const entityTypesFor = (stageId: StageId): string[] => options.entityTypes?.[stageId] ?? ['event'];

  const stageRegistry = {
    get: jest.fn((stageId: string): Stage => {
      if ((options.unbound ?? []).includes(stageId)) {
        throw new Error(`no provider is bound to token "PipelineStage:${stageId}"`);
      }

      return {
        id: stageId,
        version: 1,
        queue: 'pipeline-index',
        entityTypes: entityTypesFor(stageId as StageId),
        source: { schema: 'ci', table: 'events', idColumn: 'id', userColumn: 'user_id' },
        run: async () => new Map(),
      };
    }),
  };

  const stale = new Set(options.stale ?? []);

  const stateService = {
    selectStale: jest.fn(
      async (stage: Stage, userId: string, _cursor: unknown, limit: number, entityType: string) => {
        if (options.probeThrowsForUser === userId) {
          throw new Error('probe exploded');
        }

        // Asserted rather than assumed: the probe must be LIMIT 1. A probe that
        // paged like a sweep would cost the tick a full slice per stage per tick.
        expect(limit).toBe(1);

        const hit = stale.has(stage.id) || stale.has(`${stage.id}|${entityType}`);

        return hit ? [randomUUID()] : [];
      },
    ),
  };

  const runService = {
    startRun: jest.fn(
      async (ctx: { userId: string }, input: { kind: string; detail?: Record<string, unknown> }) => ({
        run: {
          id: options.startRun?.id ?? RUN_A,
          // Echoed back, exactly as the real service does: the run the tick goes on
          // to reconcile is whatever the database handed back, not what was asked
          // for, which is the whole point of `created: false`.
          userId: ctx.userId,
          kind: input.kind,
          detail: input.detail ?? {},
          desiredState: options.startRun?.desiredState ?? 'running',
        },
        created: options.startRun?.created ?? true,
      }),
    ),
    finishRun: jest.fn(async () => null),
  };

  const dispatchService = {
    startSweep: jest.fn(async (input: { stage: string }) => {
      if ((options.sweepThrows ?? []).includes(input.stage)) {
        throw new Error(`Unknown pipeline stage "${input.stage}"`);
      }
    }),
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  };

  // Only `status()` is ever called, and only for `.open` — the tick reads the
  // window, it never takes a turn or charges the budget. The rest of
  // `WindowStatus` is filled in because `tickConditions` logs `state` and
  // `nextOpensAt` when the window is shut.
  const windowService = {
    status: jest.fn(async () => {
      if (options.windowThrows === true) {
        throw new Error('ci.pipeline_turns is not migrated on this database');
      }

      const open = options.windowOpen ?? true;

      return {
        open,
        state: open ? 'open' : 'closed',
        nextOpensAt: new Date('2026-08-10T01:00:00.000Z'),
      };
    }),
  };

  const service = new PipelineControlService(
    dataSource as unknown as DataSource,
    stateService as unknown as PipelineStateService,
    runService as unknown as PipelineRunService,
    dispatchService as unknown as PipelineDispatchService,
    stageRegistry as unknown as StageRegistry,
    windowService as unknown as EnrichmentWindowService,
    logger as unknown as LoggerService,
  );

  return {
    service,
    statements,
    unlocks,
    released,
    logger,
    stateService,
    runService,
    dispatchService,
    stageRegistry,
    windowService,
    /** Stage ids the tick actually dispatched a sweep for, in order. */
    swept: (): string[] =>
      dispatchService.startSweep.mock.calls.map((call) => (call[0] as { stage: string }).stage),
    /** Indexes into `statements` matching a pattern — for ORDER assertions. */
    indexOf: (pattern: RegExp): number => statements.findIndex((statement) => pattern.test(statement.sql)),
  };
}

describe('PipelineControlService', () => {
  // -------------------------------------------------------------------------
  // The declared policy
  // -------------------------------------------------------------------------

  describe('the tick policy, as declared', () => {
    it('is internally consistent — every edge names a declared stage and the graph is acyclic', () => {
      expect(() => assertStagePolicy()).not.toThrow();
    });

    it('refuses an edge to a stage that does not exist', () => {
      // The failure this guards is silent: an edge naming a typo is an edge that
      // never blocks anything, so a consumer would quietly run ahead of its
      // producer forever with nothing to see.
      const graph = STAGE_DEPENDENCIES as Record<string, readonly string[]>;
      graph['enrich.typo'] = [STAGE_IDS.ENRICH_GEOCODE];

      try {
        expect(() => assertStagePolicy()).toThrow(/enrich\.typo/);
      } finally {
        delete graph['enrich.typo'];
      }
    });

    it('refuses a cycle', () => {
      const graph = STAGE_DEPENDENCIES as Record<string, readonly StageId[]>;
      const original = graph[STAGE_IDS.ENRICH_GEOCODE];
      graph[STAGE_IDS.ENRICH_GEOCODE] = [STAGE_IDS.PROMOTE_PLACE];

      try {
        expect(() => assertStagePolicy()).toThrow(/cycle/i);
      } finally {
        if (original == null) {
          delete graph[STAGE_IDS.ENRICH_GEOCODE];
        } else {
          graph[STAGE_IDS.ENRICH_GEOCODE] = original;
        }
      }
    });

    it('orders every producer ahead of every consumer', () => {
      const ordered = orderStages([...STAGE_ID_LIST]);

      expect(new Set(ordered)).toEqual(new Set(STAGE_ID_LIST));

      for (const [consumer, producers] of Object.entries(STAGE_DEPENDENCIES)) {
        for (const producer of producers ?? []) {
          expect(ordered.indexOf(producer as StageId)).toBeLessThan(ordered.indexOf(consumer as StageId));
        }
      }
    });

    it('drops an edge to a producer that is not in the set being ordered', () => {
      // A run that names only some stages must still be orderable. An edge to a
      // stage the run does not include is not a dependency of that run.
      const subset = orderStages([STAGE_IDS.PROMOTE_PLACE, STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]);

      expect(subset).toEqual([STAGE_IDS.ENRICH_MEDIA_DIMENSIONS, STAGE_IDS.PROMOTE_PLACE]);
    });

    it('admits every metered stage to the default set, bounded by three declared numbers', () => {
      // THE FLIP. The decided policy is weekly, not never, and until the dueness
      // gate landed the default set excluded these two — which made "costs
      // money" and "unreachable by a timer" the same statement.
      //
      // Being IN the set is only safe because of what is asserted beneath it, so
      // the two halves are one test: reachability plus the three numbers that
      // bound it. A metered stage that lost its `perRunCap`, or slipped to a
      // one-day interval, or escaped the window, would still be in the default
      // set and would fail here rather than on an invoice.
      for (const stageId of METERED_STAGES) {
        expect(STAGE_ID_LIST).toContain(stageId);
        expect(defaultStageSet()).toContain(stageId);

        const policy = stageSchedule(stageId);

        expect(policy.cost).toBe('metered');
        expect(policy.trigger).not.toBe('onArrival');
        expect(policy.window).toBe('enrichment');
        // SECONDS, not milliseconds — schedule.ts's units, and it warns about
        // exactly this confusion. 7 days = 604_800.
        expect(policy.minInterval).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
        expect(policy.perRunCap).toBeGreaterThan(0);
      }

      expect(isMeteredStage(STAGE_IDS.ENRICH_GEOCODE)).toBe(true);
      expect(isMeteredStage(STAGE_IDS.ENRICH_POSITION_REVERSE)).toBe(true);
      expect(isMeteredStage(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS)).toBe(false);
    });

    it('leaves every automatic stage IN the default set, so the tick is not quietly inert', () => {
      // The opposite failure to the one above, and the one this whole file
      // exists to fix: a pipeline nothing starts. Now stated against
      // `automaticStageIds()` — the schedule's own answer to "what may a timer
      // start?" — rather than against a filter written a second time here.
      expect(defaultStageSet()).toEqual(automaticStageIds());
      expect(defaultStageSet()).toEqual([...STAGE_ID_LIST]);
      expect(defaultStageSet().length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // desired_state
  // -------------------------------------------------------------------------

  describe('honouring desired_state', () => {
    it('starts nothing for a paused run', async () => {
      const h = makeControl({
        users: [runningRun({ desired_state: 'paused' })],
        stale: [...STAGE_ID_LIST],
      });

      const report = await h.service.tick();

      expect(report.runsPaused).toBe(1);
      expect(h.dispatchService.startSweep).not.toHaveBeenCalled();
      expect(h.runService.finishRun).not.toHaveBeenCalled();
    });

    it('does not even probe a paused run', async () => {
      // A paused run must cost nothing. Probing twelve stages for a run that is
      // not allowed to start anything is the most expensive way to do nothing.
      const h = makeControl({ users: [runningRun({ desired_state: 'paused' })], stale: [...STAGE_ID_LIST] });

      await h.service.tick();

      expect(h.stateService.selectStale).not.toHaveBeenCalled();
    });

    it('starts nothing for a cancelled run, however much work is outstanding', async () => {
      const h = makeControl({
        users: [runningRun({ desired_state: 'cancelled' })],
        stale: [...STAGE_ID_LIST],
      });

      await h.service.tick();

      expect(h.dispatchService.startSweep).not.toHaveBeenCalled();
      expect(h.stateService.selectStale).not.toHaveBeenCalled();
    });

    it('FINALISES a cancelled run, because an unfinalised one locks the user out forever', async () => {
      // `pipeline_runs_active_uniq` is `(user_id) WHERE finished_at IS NULL`, and
      // cancelling writes only `desired_state`. Without this call the run stays
      // active for the life of the appliance and every later startRun returns it.
      const h = makeControl({ users: [runningRun({ desired_state: 'cancelled' })] });

      const report = await h.service.tick();

      expect(h.runService.finishRun).toHaveBeenCalledTimes(1);
      expect(h.runService.finishRun).toHaveBeenCalledWith(RUN_A, 'cancelled', expect.any(Object));
      expect(report.runsFinalized).toBe(1);
    });

    it('marks a cancelled run’s unleased shards cancelled', async () => {
      const h = makeControl({ users: [runningRun({ desired_state: 'cancelled' })] });

      await h.service.tick();

      const teardown = h.statements.find(
        (statement) =>
          statement.sql.startsWith('update ci.pipeline_shards') && /where run_id/.test(statement.sql),
      );

      expect(teardown).toBeDefined();
      expect(teardown?.params).toEqual([
        RUN_A,
        SHARD_STATUS.CANCELLED,
        expect.arrayContaining([SHARD_STATUS.DONE]),
      ]);
    });

    it('waits one tick before finalising a cancelled run a worker is still inside', async () => {
      // The shard holds a live lease: a worker is mid-slice. Finalising now would
      // abandon a claim rather than let the ledger record what it decided. The
      // wait is bounded — an unrenewed lease always expires.
      const h = makeControl({ users: [runningRun({ desired_state: 'cancelled' })], liveLease: true });

      const report = await h.service.tick();

      expect(h.runService.finishRun).not.toHaveBeenCalled();
      expect(report.runsFinalized).toBe(0);
    });

    it('finalises the same cancelled run once the lease has gone', async () => {
      const h = makeControl({ users: [runningRun({ desired_state: 'cancelled' })], liveLease: false });

      await h.service.tick();

      expect(h.runService.finishRun).toHaveBeenCalledWith(RUN_A, 'cancelled', expect.any(Object));
    });

    it('abandons a tick that loses a startRun race to a paused run', async () => {
      // Another actor created the run between our read and our insert, and it is
      // not running. Honouring desired_state outranks the work we were about to
      // start.
      const h = makeControl({
        users: [noRun()],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
        startRun: { created: false, desiredState: 'paused' },
      });

      await h.service.tick();

      expect(h.dispatchService.startSweep).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Deciding what is worth sweeping
  // -------------------------------------------------------------------------

  describe('deciding what is worth sweeping', () => {
    it('starts no sweep at all when nothing is stale', async () => {
      const h = makeControl({ users: [runningRun()], stale: [] });

      const report = await h.service.tick();

      expect(h.dispatchService.startSweep).not.toHaveBeenCalled();
      expect(report.sweepsStarted).toBe(0);
    });

    it('probes with LIMIT 1 rather than paging like a sweep', async () => {
      // Asserted inside the fake `selectStale`; this test is what makes the
      // twelve-stages-per-tick cost argument true rather than aspirational.
      const h = makeControl({ users: [runningRun()], stale: [] });

      await h.service.tick();

      expect(h.stateService.selectStale).toHaveBeenCalled();
      for (const call of h.stateService.selectStale.mock.calls) {
        expect(call[3]).toBe(1);
      }
    });

    it('asks the LEDGER, never a second copy of the staleness predicate', async () => {
      // The tick issues no candidate query of its own. Every "is there work?"
      // goes through PipelineStateService.selectStale — THE ONE RULE — so the
      // definition of stale cannot drift from the one that dispatches.
      const h = makeControl({ users: [runningRun()], stale: [] });

      await h.service.tick();

      for (const { sql } of h.statements) {
        expect(sql).not.toMatch(/from ci\.pipeline_state/);
      }
    });

    it('creates no run for a user with nothing to do', async () => {
      const h = makeControl({ users: [noRun()], stale: [] });

      const report = await h.service.tick();

      expect(h.runService.startRun).not.toHaveBeenCalled();
      expect(report.runsStarted).toBe(0);
    });

    it('starts a continuous run for a user who has stale work and no run', async () => {
      const h = makeControl({ users: [noRun()], stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS] });

      const report = await h.service.tick();

      expect(h.runService.startRun).toHaveBeenCalledWith(
        { userId: USER_A },
        expect.objectContaining({ kind: CONTINUOUS_RUN_KIND }),
      );
      expect(report.runsStarted).toBe(1);
      expect(h.swept()).toContain(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS);
    });

    it('finalises a drained run, so the user is free to start another', async () => {
      const h = makeControl({ users: [runningRun()], stale: [] });

      const report = await h.service.tick();

      expect(h.runService.finishRun).toHaveBeenCalledWith(RUN_A, 'completed', expect.any(Object));
      expect(report.runsFinalized).toBe(1);
      expect(report.legsDrained).toBeGreaterThan(0);
    });

    it('does not finalise a drained run while a worker still holds a shard', async () => {
      const h = makeControl({ users: [runningRun()], stale: [], liveLease: true });

      await h.service.tick();

      expect(h.runService.finishRun).not.toHaveBeenCalled();
    });

    it('records the drained legs BEFORE asking about leases, so finalising is not delayed', async () => {
      // Nothing releases a shard lease when a sweep finishes — it is a deadline,
      // not a handshake. Asking about leases first would keep every run open for
      // up to SHARD_LEASE_SECONDS after its last leg drained, for no reason.
      const h = makeControl({ users: [runningRun()], stale: [] });

      await h.service.tick();

      const drainIndex = h.indexOf(/^insert into ci\.pipeline_shards/);
      const leaseIndex = h.indexOf(/^select s\.id from ci\.pipeline_shards/);

      expect(drainIndex).toBeGreaterThanOrEqual(0);
      expect(leaseIndex).toBeGreaterThan(drainIndex);
    });

    it('never starts more than MAX_SWEEPS_PER_TICK sweeps, whatever is outstanding', async () => {
      // Effective global concurrency is ten in-flight jobs and one sweep hop
      // enqueues five slices. More sweeps do not buy throughput; they contend.
      const h = makeControl({ users: [runningRun()], stale: [...STAGE_ID_LIST] });

      const report = await h.service.tick();

      expect(report.sweepsStarted).toBe(MAX_SWEEPS_PER_TICK);
      expect(h.swept()).toHaveLength(MAX_SWEEPS_PER_TICK);
    });

    it('names the entityType on every sweep, including single-type stages', async () => {
      // The shard is keyed by (run, stage, shard_key = entityType). Letting the
      // dispatcher default would let the shard and the ledger disagree about
      // which type was swept.
      const h = makeControl({
        users: [runningRun()],
        stale: [`${STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE}|entity`],
        entityTypes: { [STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE]: ['entity'] },
      });

      await h.service.tick();

      expect(h.dispatchService.startSweep).toHaveBeenCalledWith(
        expect.objectContaining({ stage: STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE, entityType: 'entity' }),
      );
    });

    it('treats a multi-type stage as one leg per type', async () => {
      const h = makeControl({
        users: [runningRun()],
        entityTypes: { [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: ['file', 'content'] },
        stale: [`${STAGE_IDS.ENRICH_MEDIA_DIMENSIONS}|content`],
      });

      await h.service.tick();

      expect(h.dispatchService.startSweep).toHaveBeenCalledTimes(1);
      expect(h.dispatchService.startSweep).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'content' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Ordering
  // -------------------------------------------------------------------------

  describe('respecting stage dependencies', () => {
    it('holds a consumer back while its producer still has stale rows', async () => {
      // `promote.place` reads the coordinates `enrich.geocode` writes and the
      // hierarchy it cached. Promoting first promotes the events that already had
      // coordinates and records `done` for a corpus it has not seen.
      const h = makeControl({
        users: [runningRun({ detail: { stages: [STAGE_IDS.ENRICH_GEOCODE, STAGE_IDS.PROMOTE_PLACE] } })],
        stale: [STAGE_IDS.ENRICH_GEOCODE, STAGE_IDS.PROMOTE_PLACE],
      });

      const report = await h.service.tick();

      expect(h.swept()).toEqual([STAGE_IDS.ENRICH_GEOCODE]);
      expect(report.legsBlocked).toBe(1);
    });

    it('releases the consumer on the tick after the producer drains', async () => {
      const h = makeControl({
        users: [runningRun({ detail: { stages: [STAGE_IDS.ENRICH_GEOCODE, STAGE_IDS.PROMOTE_PLACE] } })],
        stale: [STAGE_IDS.PROMOTE_PLACE],
      });

      await h.service.tick();

      expect(h.swept()).toEqual([STAGE_IDS.PROMOTE_PLACE]);
    });

    it('blocks transitively, so a grandchild does not run ahead of a grandparent', async () => {
      // identifier_normalize -> person_link -> duplicate_detect. Only the first
      // has candidates; `duplicate_detect` has none of its own but its evidence
      // table has not been written yet, and running it now would record
      // `skipped: no_identifier_claims` across the corpus.
      const h = makeControl({
        users: [
          runningRun({
            detail: {
              stages: [
                STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE,
                STAGE_IDS.ENRICH_PERSON_LINK,
                STAGE_IDS.CLEAN_DUPLICATE_DETECT,
              ],
            },
          }),
        ],
        stale: [STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE, STAGE_IDS.CLEAN_DUPLICATE_DETECT],
      });

      await h.service.tick();

      expect(h.swept()).toEqual([STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE]);
    });

    it('never records a blocked leg as drained', async () => {
      // The wedge this prevents: `promote.place` has nothing stale YET because
      // its producer has not filled the column its predicate reads. Marking it
      // `done` would retire it from a run it has not begun.
      const h = makeControl({
        users: [runningRun({ detail: { stages: [STAGE_IDS.ENRICH_GEOCODE, STAGE_IDS.PROMOTE_PLACE] } })],
        stale: [STAGE_IDS.ENRICH_GEOCODE],
      });

      const report = await h.service.tick();

      expect(report.legsBlocked).toBe(1);
      expect(report.legsDrained).toBe(0);

      const drains = h.statements.filter(
        (statement) =>
          statement.sql.startsWith('insert into ci.pipeline_shards') && !/make_interval/.test(statement.sql),
      );

      expect(drains).toHaveLength(0);
    });

    it('does not let a producer that is not in the run block anything', async () => {
      // A producer the run does not include is not being waited for. Asserted
      // with a run that names only the consumer, so the edge to `enrich.geocode`
      // is dropped even though that stage has stale rows.
      const h = makeControl({
        users: [runningRun({ detail: { stages: [STAGE_IDS.ENRICH_ESTIMATE_LOCATION] } })],
        stale: [STAGE_IDS.ENRICH_GEOCODE, STAGE_IDS.ENRICH_ESTIMATE_LOCATION],
      });

      await h.service.tick();

      expect(h.swept()).toEqual([STAGE_IDS.ENRICH_ESTIMATE_LOCATION]);
    });

    it('does not let a producer that is not DUE block anything', async () => {
      // THE BUG the dueness filter fixes, and it is a real one rather than a
      // hypothetical: `enrich.estimate_location` and `promote.place` are NIGHTLY
      // and both consume the WEEKLY `enrich.geocode`. Geocode has stale rows on
      // all seven nights and may run on one of them, so a consumer blocked
      // whenever its producer merely HAS candidates would be held back six
      // nights in seven — by a producer that was never going to run on any of
      // them.
      const h = makeControl({
        // Producer and consumer alone, so the only edge in play is the one under
        // test — `promote.place` consumes the estimator too and would be legitimately
        // blocked by it, which is a different fact.
        users: [
          runningRun({
            detail: { stages: [STAGE_IDS.ENRICH_GEOCODE, STAGE_IDS.ENRICH_ESTIMATE_LOCATION] },
          }),
        ],
        stale: [STAGE_IDS.ENRICH_GEOCODE, STAGE_IDS.ENRICH_ESTIMATE_LOCATION],
        // Geocode ran an hour ago, so it is six days off being due. The consumer
        // has never run, so it is overdue and wants to go tonight.
        lastStartedAt: { [STAGE_IDS.ENRICH_GEOCODE]: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const report = await h.service.tick();

      expect(h.swept()).toEqual([STAGE_IDS.ENRICH_ESTIMATE_LOCATION]);
      expect(report.legsBlocked).toBe(0);
      expect(report.legsNotDue).toBe(1);
    });

    it('dispatches producers before consumers within one tick', async () => {
      const h = makeControl({
        users: [
          runningRun({
            detail: { stages: [STAGE_IDS.PROMOTE_PLACE, STAGE_IDS.ENRICH_ESTIMATE_LOCATION] },
          }),
        ],
        stale: [STAGE_IDS.ENRICH_ESTIMATE_LOCATION],
      });

      await h.service.tick();

      // The consumer is blocked, so only the producer runs — and the run's stage
      // list was written consumer-first on purpose, to prove the order comes from
      // the graph and not from the caller's array.
      expect(h.swept()).toEqual([STAGE_IDS.ENRICH_ESTIMATE_LOCATION]);
    });
  });

  // -------------------------------------------------------------------------
  // Cost discipline
  // -------------------------------------------------------------------------

  describe('metered stages', () => {
    it('auto-sweeps a metered stage that has never run, and bounds it with its perRunCap', async () => {
      // The first pass. A never-run leg is infinitely stale and therefore
      // overdue, which is what makes a freshly imported appliance geocode
      // tonight instead of in a week — and the ONLY thing bounding that first
      // pass is `perRunCap`, which is the argument for the cap mattering more
      // than the interval.
      const h = makeControl({ users: [runningRun()], stale: [...STAGE_ID_LIST] });

      await h.service.tick();

      for (const stageId of METERED_STAGES) {
        expect(h.swept()).toContain(stageId);

        const started = h.dispatchService.startSweep.mock.calls
          .map((candidate) => candidate[0] as { stage: string; maxIds?: number })
          .find((input) => input.stage === stageId);

        // Not merely "a cap": the DECLARED one. A sweep started with the wrong
        // number is a bill of the wrong size, and nothing downstream would say
        // so.
        expect(started?.maxIds).toBe(stageSchedule(stageId).perRunCap);
      }
    });

    it('passes no cap for a stage that declares none', async () => {
      // `undefined`, not `0` and not `Infinity`. `StartSweepInput.maxIds` is
      // optional and the dispatcher reads absent as uncapped; a 0 would read as
      // "dispatch nothing" and silently stop every free stage on the appliance.
      const h = makeControl({
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
      });

      await h.service.tick();

      expect(stageSchedule(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS).perRunCap).toBeUndefined();
      expect(h.dispatchService.startSweep.mock.calls[0][0]).toMatchObject({
        stage: STAGE_IDS.ENRICH_MEDIA_DIMENSIONS,
        maxIds: undefined,
      });
    });

    it('does NOT re-sweep a metered stage inside its weekly interval', async () => {
      // The whole point of the gate. Same stale rows, same open window, same
      // tick — and the only difference is a row in `ci.pipeline_schedule` from
      // yesterday.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const h = makeControl({
        users: [runningRun()],
        stale: [...METERED_STAGES],
        lastStartedAt: Object.fromEntries([...METERED_STAGES].map((stageId) => [stageId, yesterday])),
      });

      const report = await h.service.tick();

      expect(h.swept()).toEqual([]);
      expect(report.legsNotDue).toBe(METERED_STAGES.size);
    });

    it('sweeps a metered stage again once its minInterval has elapsed', async () => {
      // The other half of the same fact, and the one that proves the gate is a
      // CADENCE rather than the old exclusion wearing a new name: eight days is
      // past a seven-day interval, so it runs.
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      const h = makeControl({
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_GEOCODE],
        lastStartedAt: { [STAGE_IDS.ENRICH_GEOCODE]: eightDaysAgo },
      });

      await h.service.tick();

      expect(h.swept()).toEqual([STAGE_IDS.ENRICH_GEOCODE]);
    });

    it('stamps the schedule BEFORE it starts the sweep', async () => {
      // The ordering that decides what a crash costs. Stamping after dispatch
      // means a process killed in between leaves no record that the sweep ever
      // started — so the next tick finds the leg due and bills for it again, on
      // a two-minute cadence, for as long as the crash repeats.
      const h = makeControl({ users: [runningRun()], stale: [STAGE_IDS.ENRICH_GEOCODE] });

      await h.service.tick();

      const stamped = h.indexOf(/^insert into ci\.pipeline_schedule/);
      const claimed = h.indexOf(/^insert into ci\.pipeline_shards.*make_interval/);

      expect(stamped).toBeGreaterThan(claimed);
      expect(h.statements[stamped].params.slice(0, 3)).toEqual([USER_A, STAGE_IDS.ENRICH_GEOCODE, 'event']);
      // `startSweep` is called after the statement log already holds the stamp.
      expect(h.dispatchService.startSweep).toHaveBeenCalled();
    });

    it('reaches a metered stage from a run the tick started itself', async () => {
      const h = makeControl({ users: [noRun()], stale: [...STAGE_ID_LIST] });

      await h.service.tick();

      const input = h.runService.startRun.mock.calls[0]?.[1];

      // The run the tick creates still names no stages — the cadence lives in
      // the schedule now, not in what a run happens to be called.
      expect(input?.detail).not.toHaveProperty('stages');
      expect(h.swept()).toContain(STAGE_IDS.ENRICH_GEOCODE);
    });

    it('holds a named run to the same interval as an unnamed one', async () => {
      // Naming a stage decides WHICH stages a run considers; it is not a bypass.
      // Before the gate it had to be one, because naming was the only way to
      // reach a metered stage at all — that is the behaviour this pins as gone.
      const h = makeControl({
        users: [runningRun({ kind: 'reprocess', detail: { stages: [STAGE_IDS.ENRICH_GEOCODE] } })],
        stale: [STAGE_IDS.ENRICH_GEOCODE],
        lastStartedAt: { [STAGE_IDS.ENRICH_GEOCODE]: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const report = await h.service.tick();

      expect(h.swept()).toEqual([]);
      expect(report.legsNotDue).toBe(1);
    });

    it('sweeps a named metered stage that IS due', async () => {
      const h = makeControl({
        users: [runningRun({ kind: 'reprocess', detail: { stages: [STAGE_IDS.ENRICH_GEOCODE] } })],
        stale: [STAGE_IDS.ENRICH_GEOCODE],
      });

      await h.service.tick();

      expect(h.swept()).toEqual([STAGE_IDS.ENRICH_GEOCODE]);
    });

    it('falls back to the default set — not to nothing — when detail.stages is unusable', async () => {
      // An empty set would make the run instantly "drained" and finalise it, so a
      // typo would be indistinguishable from a complete, successful run.
      const h = makeControl({
        users: [runningRun({ detail: { stages: ['enrich.nonexistent'] } })],
        stale: [...STAGE_ID_LIST],
      });

      await h.service.tick();

      expect(h.swept().length).toBeGreaterThan(0);
      expect(h.logger.warn).toHaveBeenCalled();
    });

    it.each([
      ['a string', 'enrich.geocode'],
      ['a number', 7],
      ['null', null],
    ])('falls back to the default set when detail.stages is %s', async (_label, stages) => {
      const h = makeControl({
        users: [runningRun({ detail: { stages } as Record<string, unknown> })],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS, STAGE_IDS.ENRICH_GEOCODE],
      });

      await h.service.tick();

      // Declaration order: `enrich.media_dimensions` precedes `enrich.geocode`,
      // and neither depends on the other.
      expect(h.swept()).toEqual([STAGE_IDS.ENRICH_MEDIA_DIMENSIONS, STAGE_IDS.ENRICH_GEOCODE]);
    });
  });

  // -------------------------------------------------------------------------
  // The clock and the window
  // -------------------------------------------------------------------------

  describe('dueness', () => {
    it('reads the schedule once per user, not once per leg', async () => {
      // The tick already issues a staleness probe per leg. A second per-leg round
      // trip to answer a question one `WHERE user_id = $1` covers would double
      // its statement count for nothing.
      const h = makeControl({ users: [runningRun(), noRun({ user_id: USER_B })] });

      await h.service.tick();

      const reads = h.statements.filter((statement) => /from ci\.pipeline_schedule/.test(statement.sql));

      expect(reads).toHaveLength(2);
      expect(reads.map((statement) => statement.params[0])).toEqual([USER_A, USER_B]);
    });

    it('holds a nightly stage back while the window is shut', async () => {
      const h = makeControl({
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
        lastStartedAt: { [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: new Date(Date.now() - 36 * 60 * 60 * 1000) },
        windowOpen: false,
      });

      const report = await h.service.tick();

      // Past its 1-day interval, inside its 3-day maxStaleness: due by the clock
      // and waiting on the window.
      expect(h.swept()).toEqual([]);
      expect(report.legsNotDue).toBe(1);
    });

    it('runs an OVERDUE stage even while the window is shut', async () => {
      // `maxStaleness` is the window's override, and it is what keeps a nightly
      // window from being a way to never run: an appliance that is powered off
      // every night at 03:00 would otherwise never enrich anything, forever.
      const h = makeControl({
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
        lastStartedAt: {
          [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
        },
        windowOpen: false,
      });

      await h.service.tick();

      expect(h.swept()).toEqual([STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]);
    });

    it('runs a NEVER-RUN stage while the window is shut, so a fresh import is not held for a night', async () => {
      const h = makeControl({
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
        windowOpen: false,
      });

      await h.service.tick();

      expect(h.swept()).toEqual([STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]);
    });

    it('treats an unreadable window as SHUT, and still runs what is overdue', async () => {
      // Fails closed, for BackpressureService's reason: a wrong "no" costs one
      // tick, a wrong "yes" is a metered call nobody authorised. Closed is not
      // stopped — `maxStaleness` still gets everything moving eventually.
      const h = makeControl({
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS, STAGE_IDS.CLEAN_TEMPORAL_REPAIR],
        lastStartedAt: {
          [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: new Date(Date.now() - 36 * 60 * 60 * 1000),
          [STAGE_IDS.CLEAN_TEMPORAL_REPAIR]: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
        },
        windowThrows: true,
      });

      await h.service.tick();

      expect(h.swept()).toEqual([STAGE_IDS.CLEAN_TEMPORAL_REPAIR]);
      expect(h.logger.error).toHaveBeenCalled();
    });

    it('reads the window ONCE per tick, not once per user', async () => {
      const h = makeControl({ users: [runningRun(), noRun({ user_id: USER_B })] });

      await h.service.tick();

      expect(h.windowService.status).toHaveBeenCalledTimes(1);
    });

    it('finalises a run whose only remaining work is not due, and says so', async () => {
      // `pipeline_runs_active_uniq` allows one unfinished run per user, so
      // holding this one open for the six days until geocode comes round would
      // lock the user out of ever starting another. The reason distinguishes it
      // from a genuine drain: `not_due` means there IS work left.
      const h = makeControl({
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_GEOCODE],
        lastStartedAt: { [STAGE_IDS.ENRICH_GEOCODE]: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const report = await h.service.tick();

      expect(report.runsFinalized).toBe(1);
      expect(h.runService.finishRun).toHaveBeenCalledWith(
        RUN_A,
        'completed',
        expect.objectContaining({ finalizedReason: 'not_due', legsNotDue: 1 }),
      );
    });

    it('does not mark a not-due leg drained', async () => {
      // A leg with work is not a leg that is finished, and the run's progress
      // view is where somebody answers "is my import done?".
      const h = makeControl({
        users: [runningRun({ detail: { stages: [STAGE_IDS.ENRICH_GEOCODE] } })],
        stale: [STAGE_IDS.ENRICH_GEOCODE],
        lastStartedAt: { [STAGE_IDS.ENRICH_GEOCODE]: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const report = await h.service.tick();

      expect(report.legsDrained).toBe(0);
      expect(report.legsNotDue).toBe(1);

      const drains = h.statements.filter(
        (statement) =>
          statement.sql.startsWith('insert into ci.pipeline_shards') && !/make_interval/.test(statement.sql),
      );

      expect(drains).toHaveLength(0);
    });

    it('starts no run at all for a user whose only work is not due', async () => {
      const h = makeControl({
        users: [noRun()],
        stale: [STAGE_IDS.ENRICH_GEOCODE],
        lastStartedAt: { [STAGE_IDS.ENRICH_GEOCODE]: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const report = await h.service.tick();

      expect(h.runService.startRun).not.toHaveBeenCalled();
      expect(report.runsStarted).toBe(0);
      expect(h.swept()).toEqual([]);
    });

    it('refuses to tick at all when ci.pipeline_schedule is missing', async () => {
      // Fail CLOSED. Without the table nothing can answer "when did this leg last
      // run?", every leg reads as never-run, and a weekly metered stage would be
      // swept on EVERY tick of a node that started before the migration landed.
      const h = makeControl({ controlPlane: false, users: [runningRun()], stale: [...STAGE_ID_LIST] });

      const report = await h.service.tick();

      expect(report.skipped).toBe(true);
      expect(h.dispatchService.startSweep).not.toHaveBeenCalled();

      const probe = h.statements.find((statement) => /to_regclass/.test(statement.sql));

      expect(probe?.sql).toContain('ci.pipeline_schedule');
    });
  });

  // -------------------------------------------------------------------------
  // Re-entrancy
  // -------------------------------------------------------------------------

  describe('re-entrancy', () => {
    it('does nothing at all when another tick holds the advisory lock', async () => {
      const h = makeControl({ lock: false, users: [runningRun()], stale: [...STAGE_ID_LIST] });

      const report = await h.service.tick();

      expect(report.skipped).toBe(true);
      expect(report.skipReason).toMatch(/advisory lock/);
      expect(h.dispatchService.startSweep).not.toHaveBeenCalled();
      expect(h.stateService.selectStale).not.toHaveBeenCalled();
      // Not one statement outside the lock attempt itself.
      expect(h.statements).toHaveLength(1);
    });

    it('takes the lock in POSTGRES, not in a field on the service', async () => {
      // An in-memory guard gives the same answer today and the wrong one the day
      // the worker process is split out — which is the change this file exists to
      // survive. `pg_try_advisory_lock` is shared by every replica of every
      // process pointed at this database.
      const h = makeControl({ users: [runningRun()], stale: [] });

      await h.service.tick();

      expect(h.statements[0].sql).toMatch(/pg_try_advisory_lock/);
    });

    it('tries the lock rather than waiting for it', async () => {
      // The blocking form would queue every replica's cron behind the winner and
      // then run them all in sequence — a slower version of the double dispatch
      // it was meant to prevent.
      const h = makeControl({ users: [runningRun()], stale: [] });

      await h.service.tick();

      for (const { sql } of h.statements) {
        expect(sql).not.toMatch(/pg_advisory_lock\(/);
      }
    });

    it('releases the lock before the connection goes back to the pool', async () => {
      // A session-level lock outlives the transaction but not the backend. Left
      // held on a POOLED connection it would wedge every later tick until that
      // connection is recycled.
      const h = makeControl({ users: [runningRun()], stale: [] });

      await h.service.tick();

      expect(h.unlocks).toHaveLength(1);
      expect(h.released).toHaveLength(1);
    });

    it('releases the lock even when the pass throws', async () => {
      // A tick that died holding the lock would wedge every later tick until the
      // pooled connection was recycled — a stall measured in minutes, caused by
      // an error that was already being reported.
      const h = makeControl({ users: [runningRun()], failOn: /from ci\.users/ });

      await expect(h.service.tick()).rejects.toThrow('connection terminated');

      expect(h.unlocks).toHaveLength(1);
      expect(h.released).toHaveLength(1);
    });

    it('lets exactly one of two overlapping ticks do the work', async () => {
      const h = makeControl({
        lock: [true, false],
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
      });

      const [first, second] = await Promise.all([h.service.tick(), h.service.tick()]);

      expect([first.skipped, second.skipped].sort()).toEqual([false, true]);
      expect(h.dispatchService.startSweep).toHaveBeenCalledTimes(1);
    });

    it('starts nothing for a leg whose shard lease another tick already holds', async () => {
      // The correctness boundary, independent of the advisory lock: even if two
      // ticks ran concurrently, the `ON CONFLICT ... WHERE` hands the leg to one
      // of them and the loser gets no row back.
      const h = makeControl({
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
        claimDenied: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
      });

      const report = await h.service.tick();

      expect(h.dispatchService.startSweep).not.toHaveBeenCalled();
      expect(report.sweepsStarted).toBe(0);
    });

    it('claims the shard BEFORE dispatching, never after', async () => {
      // Dispatching first and claiming after would leave a window where two ticks
      // both enqueue a sweep for the same leg.
      const h = makeControl({ users: [runningRun()], stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS] });

      let statementsAtSweep = -1;
      h.dispatchService.startSweep.mockImplementation(async () => {
        statementsAtSweep = h.statements.length;
      });

      await h.service.tick();

      const claimIndex = h.indexOf(/^insert into ci\.pipeline_shards.*make_interval/);

      expect(claimIndex).toBeGreaterThanOrEqual(0);
      expect(statementsAtSweep).toBeGreaterThan(claimIndex);
    });
  });

  // -------------------------------------------------------------------------
  // Lease reaping
  // -------------------------------------------------------------------------

  describe('reaping expired shard leases', () => {
    it('reaps before it dispatches, so a reclaimed leg can be picked up this tick', async () => {
      const h = makeControl({ users: [runningRun()], stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS], reaped: 2 });

      await h.service.tick();

      const reapIndex = h.indexOf(/^with reaped as/);
      const claimIndex = h.indexOf(/^insert into ci\.pipeline_shards.*make_interval/);

      expect(reapIndex).toBeGreaterThanOrEqual(0);
      expect(claimIndex).toBeGreaterThan(reapIndex);
    });

    it('reports what it reclaimed and says so at warn level', async () => {
      // Reaching this line means a worker died holding work. Fully recovered
      // from, and still worth seeing.
      const h = makeControl({ users: [], reaped: 3 });

      const report = await h.service.tick();

      expect(report.leasesReaped).toBe(3);
      expect(h.logger.warn).toHaveBeenCalled();
    });

    it('says nothing on the steady-state empty reap', async () => {
      // This runs every two minutes forever on a healthy appliance.
      const h = makeControl({ users: [], reaped: 0 });

      await h.service.tick();

      expect(h.logger.warn).not.toHaveBeenCalled();
    });

    it('reaps appliance-wide, not just for the runs it is reconciling', async () => {
      // A stranded lease is stranded regardless of whose run it belongs to,
      // including a paused one. A reaper that only visited runs it was already
      // reconciling would leave exactly the shards nobody is looking at.
      const h = makeControl({ users: [], reaped: 1 });

      await h.service.tick();

      const reap = h.statements.find((statement) => /where id in \(/.test(statement.sql));

      expect(reap).toBeDefined();
      expect(reap?.sql).not.toMatch(/run_id/);
      expect(reap?.sql).not.toMatch(/user_id/);
    });

    it('wraps the reaping UPDATE in a CTE, because DataSource.query lies about an UPDATE', async () => {
      // TypeORM's PostgresQueryRunner special-cases the UPDATE and DELETE
      // commands and resolves `[raw.rows, raw.rowCount]` — a two-element array
      // whatever the statement matched. Read as rows, a reap that reclaimed
      // NOTHING reports 2, and no mock-based test can see it because the mock
      // answers with whatever shape the test wrote. Making the outer command a
      // SELECT is what gets the rows back; this pins it so it cannot be
      // "simplified" away.
      const h = makeControl({ users: [], reaped: 0 });

      await h.service.tick();

      const reap = h.statements.find((statement) => /where id in \(/.test(statement.sql));

      expect(reap?.sql).toMatch(/^with .* as \( update ci\.pipeline_shards/);
      expect(reap?.sql).toMatch(/select id from/);
    });
  });

  // -------------------------------------------------------------------------
  // Failure containment
  // -------------------------------------------------------------------------

  describe('when something goes wrong', () => {
    it('never rejects out of the scheduled tick — an unhandled tick would exit the process', async () => {
      // `@Cron` is @nestjs/schedule, which builds `CronJob.from({ onTick })`
      // without `waitForCompletion`, so `fireOnTick` never awaits the callback.
      // An async tick that rejects is an unhandled rejection, and
      // `application.ts` answers those with `process.exit(1)`. On a two-minute
      // timer that is a crash loop.
      const h = makeControl({ users: [runningRun()], failOn: /from ci\.users/ });

      await expect(h.service.tickOnSchedule()).resolves.toBeUndefined();
      expect(h.logger.error).toHaveBeenCalled();
    });

    it('propagates out of the awaited tick, so a caller that asked hears about it', async () => {
      // The two entry points diverge deliberately. A cron must never reject; a
      // caller that awaited a tick wants to be told it failed rather than getting
      // a report of zeroes that reads like a quiet appliance.
      const h = makeControl({ users: [runningRun()], failOn: /from ci\.users/ });

      await expect(h.service.tick()).rejects.toThrow('connection terminated');
    });

    it('does not let one user’s failure cost every other user their tick', async () => {
      const h = makeControl({
        users: [runningRun({ user_id: USER_A }), runningRun({ user_id: USER_B, run_id: null })],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
        probeThrowsForUser: USER_A,
      });

      const report = await h.service.tick();

      expect(h.logger.error).toHaveBeenCalled();
      expect(report.usersServiced).toBe(2);
      expect(h.swept()).toEqual([STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]);
    });

    it('skips a stage it cannot resolve instead of losing the whole tick', async () => {
      // A declared-but-unbound stage is a wiring fault. `StageRegistry.get`
      // throwing is right at a sweep's call site and fatal here, where the caller
      // is a timer.
      const h = makeControl({
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS, STAGE_IDS.CLEAN_TEMPORAL_REPAIR],
        unbound: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
      });

      await h.service.tick();

      expect(h.logger.error).toHaveBeenCalled();
      expect(h.swept()).toEqual([STAGE_IDS.CLEAN_TEMPORAL_REPAIR]);
    });

    it('leaves the lease in place when a sweep fails to start, so the retry is backed off', async () => {
      // `startSweep` throws only for a wiring fault, which a retry every two
      // minutes cannot fix but a deploy can. The held lease expires in
      // SHARD_LEASE_SECONDS and is then reaped — a free backoff.
      const h = makeControl({
        users: [runningRun()],
        stale: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
        sweepThrows: [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS],
      });

      const report = await h.service.tick();

      expect(report.sweepsStarted).toBe(0);
      expect(h.logger.error).toHaveBeenCalled();

      // Nothing releases the lease it just took: no drain, no reset, nothing that
      // would make the leg immediately claimable again by the next tick.
      const releases = h.statements.filter(
        (statement) =>
          statement.sql.startsWith('insert into ci.pipeline_shards') &&
          !/make_interval/.test(statement.sql) &&
          statement.params[1] === STAGE_IDS.ENRICH_MEDIA_DIMENSIONS,
      );

      expect(releases).toHaveLength(0);
    });

    it('does nothing on a database whose control plane has not been migrated', async () => {
      // Same guard, and the same reason, as the dead-letter reaper's: on a timer
      // an unguarded missing relation is a log line every two minutes forever.
      const h = makeControl({ controlPlane: false, users: [runningRun()], stale: [...STAGE_ID_LIST] });

      const report = await h.service.tick();

      expect(report.skipped).toBe(true);
      expect(report.skipReason).toMatch(/migrated/);
      expect(h.dispatchService.startSweep).not.toHaveBeenCalled();
    });

    it('excludes deleted and deactivated users from the sweep', async () => {
      // Their rows are still in the source tables and would sweep perfectly
      // happily, which is the problem: an account being wound down should not be
      // spending Ollama time or provider budget.
      const h = makeControl({ users: [] });

      await h.service.tick();

      const userQuery = h.statements.find((statement) => /from ci\.users/.test(statement.sql));

      expect(userQuery?.sql).toMatch(/deleted_at is null/);
      expect(userQuery?.sql).toMatch(/is_active/);
    });
  });
});

// ---------------------------------------------------------------------------
// Half two: the SQL, against real Postgres
// ---------------------------------------------------------------------------

describeWithDatabase('PipelineControlService — shard leases (real Postgres)', () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let service: PipelineControlService;
  let runId: string;

  const leg = (stage: string, entityType = 'event'): StageLeg =>
    ({ stageId: stage as StageId, entityType, stage: null as unknown as Stage }) as StageLeg;

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('databaseAvailability() said yes but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      // Discrete fields, never a URL assembled here: the dev password ends in
      // `!` and must not have to survive percent-encoding.
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      entities: [],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });

    await dataSource.initialize();

    const [present] = await dataSource.query<Array<{ runs: string | null; shards: string | null }>>(
      `SELECT to_regclass('ci.pipeline_runs')::text AS runs, to_regclass('ci.pipeline_shards')::text AS shards`,
    );

    // A reachable database missing the tables is a broken SETUP, not an absent
    // one: it must fail here naming the fix, because skipping would turn a
    // migration mistake into a green run.
    if (present.runs == null || present.shards == null) {
      throw new Error(
        'ci.pipeline_runs / ci.pipeline_shards are missing — run `yarn workspace @ci/be-api migrate` and ' +
          're-run this suite.',
      );
    }
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    const silent = {
      setContext: () => undefined,
      log: () => undefined,
      debug: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      verbose: () => undefined,
    } as unknown as LoggerService;

    service = new PipelineControlService(
      {
        query: (sql: string, params?: unknown[]) => runner.query(sql, params),
        // Never reached: these tests drive the two SQL primitives directly rather
        // than a whole tick, precisely so no advisory lock is taken on a
        // connection this suite is about to roll back.
        createQueryRunner: () => {
          throw new Error('the database half drives the SQL primitives directly, not tick()');
        },
      } as unknown as DataSource,
      null as unknown as PipelineStateService,
      null as unknown as PipelineRunService,
      null as unknown as PipelineDispatchService,
      null as unknown as StageRegistry,
      // Never reached: these tests drive the SQL primitives directly, and none of
      // them reads the window.
      null as unknown as EnrichmentWindowService,
      silent,
    );

    // A run to hang shards off: `pipeline_shards.run_id` REFERENCES
    // `pipeline_runs(id)`. A random user id, because the control plane
    // deliberately has no FK to ci.users — and because a real user id would risk
    // `pipeline_runs_active_uniq` colliding with the appliance's own run.
    const inserted = (await runner.query(
      `INSERT INTO ci.pipeline_runs (user_id, kind, desired_state, status)
            VALUES ($1::uuid, 'test', 'running', 'queued')
         RETURNING id`,
      [randomUUID()],
    )) as Array<{ id: string }>;

    runId = inserted[0].id;
  });

  afterEach(async () => {
    // ALWAYS a rollback. Nothing this suite writes is ever committed, so the
    // live appliance's own control plane never sees a synthetic run.
    await runner.rollbackTransaction();
    await runner.release();
  });

  interface ShardRow {
    id: string;
    stage: string;
    shard_key: string;
    cursor: string | null;
    status: string;
    lease_owner: string | null;
    lease_expires_at: Date | null;
  }

  async function shards(): Promise<ShardRow[]> {
    const rows: unknown = await runner.query(
      `SELECT * FROM ci.pipeline_shards WHERE run_id = $1::uuid ORDER BY stage, shard_key`,
      [runId],
    );

    return rows as ShardRow[];
  }

  /** A shard in whatever state the test needs, bypassing the service. */
  async function seedShard(fields: {
    stage: string;
    shardKey?: string;
    status: string;
    leaseSeconds?: number | null;
  }): Promise<string> {
    const inserted = (await runner.query(
      `INSERT INTO ci.pipeline_shards (run_id, stage, shard_key, "cursor", status, lease_owner, lease_expires_at)
            VALUES ($1::uuid, $2, $3, NULL, $4, 'someone-else',
                    CASE WHEN $5::float8 IS NULL THEN NULL ELSE now() + make_interval(secs => $5::float8) END)
         RETURNING id`,
      [runId, fields.stage, fields.shardKey ?? 'event', fields.status, fields.leaseSeconds ?? null],
    )) as Array<{ id: string }>;

    return inserted[0].id;
  }

  describe('claiming a leg', () => {
    it('materialises the shard and leases it on the first claim', async () => {
      const id = await service.claimStageShard(runId, leg(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS));

      expect(id).not.toBeNull();

      const [row] = await shards();
      expect(row.stage).toBe(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS);
      expect(row.shard_key).toBe('event');
      expect(row.status).toBe(SHARD_STATUS.RUNNING);
      expect(row.lease_owner).toContain(String(process.pid));
      expect(row.lease_expires_at).not.toBeNull();

      // The lease is the declared one, not an invented number. Compared loosely
      // because `now()` moved between the INSERT and this read.
      const remaining = (new Date(row.lease_expires_at as Date).getTime() - Date.now()) / 1000;
      expect(remaining).toBeGreaterThan(SHARD_LEASE_SECONDS - 60);
      expect(remaining).toBeLessThanOrEqual(SHARD_LEASE_SECONDS + 1);
    });

    it('leaves `cursor` NULL rather than inventing a keyset position', async () => {
      // A Phase-1 sweep carries its cursor in `pgboss.job.data`. Writing a stale
      // value into this column would be worse than leaving it empty, because the
      // sharded planner will one day read it.
      await service.claimStageShard(runId, leg(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS));

      const [row] = await shards();
      expect(row.cursor).toBeNull();
    });

    it('refuses a second claimant while the lease is live', async () => {
      // THE re-entrancy guarantee. Two ticks racing over the same leg both run
      // this upsert; exactly one gets a row back.
      const first = await service.claimStageShard(runId, leg(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS));
      const second = await service.claimStageShard(runId, leg(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS));

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(await shards()).toHaveLength(1);
    });

    it('hands the leg over once the lease has expired', async () => {
      await seedShard({
        stage: STAGE_IDS.ENRICH_MEDIA_DIMENSIONS,
        status: SHARD_STATUS.RUNNING,
        leaseSeconds: -60,
      });

      const claimed = await service.claimStageShard(runId, leg(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS));

      expect(claimed).not.toBeNull();

      const [row] = await shards();
      expect(row.lease_owner).not.toBe('someone-else');
    });

    it('re-claims a DRAINED leg, because a done shard must not be able to wedge a run', async () => {
      // If `done` refused a claim, a leg that became stale again inside the same
      // run — a producer filling its column, an import landing rows, a version
      // bump — could never be dispatched, and the run could never finalise
      // because something was stale. That is a permanent lockout for the user.
      await seedShard({ stage: STAGE_IDS.PROMOTE_PLACE, status: SHARD_STATUS.DONE, leaseSeconds: null });

      const claimed = await service.claimStageShard(runId, leg(STAGE_IDS.PROMOTE_PLACE));

      expect(claimed).not.toBeNull();
      expect((await shards())[0].status).toBe(SHARD_STATUS.RUNNING);
    });

    it('refuses a CANCELLED leg, so a run being torn down cannot be resurrected', async () => {
      await seedShard({ stage: STAGE_IDS.PROMOTE_PLACE, status: SHARD_STATUS.CANCELLED, leaseSeconds: null });

      expect(await service.claimStageShard(runId, leg(STAGE_IDS.PROMOTE_PLACE))).toBeNull();
      expect((await shards())[0].status).toBe(SHARD_STATUS.CANCELLED);
    });

    it('keys a multi-type stage’s legs separately', async () => {
      // `ci.pipeline_state` is keyed per (entity_type, entity_id, stage), so two
      // types are two independent sweeps with two independent cursors — which is
      // exactly what shard_key is for.
      expect(
        await service.claimStageShard(runId, leg(STAGE_IDS.ENRICH_PERSON_LINK, 'communication')),
      ).not.toBeNull();
      expect(await service.claimStageShard(runId, leg(STAGE_IDS.ENRICH_PERSON_LINK, 'event'))).not.toBeNull();

      expect((await shards()).map((row) => row.shard_key)).toEqual(['communication', 'event']);
    });
  });

  describe('reaping expired leases', () => {
    it('hands an expired lease back as pending, keeping the shard’s identity', async () => {
      // A worker that is SIGKILLed never releases anything. Without this the
      // shard sits `running` with a dead owner and the claim refuses it forever.
      const id = await seedShard({
        stage: STAGE_IDS.ENRICH_MEDIA_DIMENSIONS,
        status: SHARD_STATUS.RUNNING,
        leaseSeconds: -1,
      });

      await expect(service.reapExpiredShardLeases()).resolves.toBeGreaterThanOrEqual(1);

      const [row] = await shards();
      expect(row.id).toBe(id);
      expect(row.status).toBe(SHARD_STATUS.PENDING);
      expect(row.lease_owner).toBeNull();
      expect(row.lease_expires_at).toBeNull();
    });

    it('leaves a live lease alone', async () => {
      await seedShard({
        stage: STAGE_IDS.ENRICH_MEDIA_DIMENSIONS,
        status: SHARD_STATUS.RUNNING,
        leaseSeconds: 600,
      });

      await service.reapExpiredShardLeases();

      const [row] = await shards();
      expect(row.status).toBe(SHARD_STATUS.RUNNING);
      expect(row.lease_owner).toBe('someone-else');
    });

    it.each([[SHARD_STATUS.DONE], [SHARD_STATUS.CANCELLED]])(
      'leaves a %s shard alone even with an expired lease',
      async (status) => {
        // Terminal is terminal: resetting one to `pending` would make the run's
        // progress view flap and would re-open a leg the operator cancelled.
        await seedShard({ stage: STAGE_IDS.PROMOTE_OBJECT, status, leaseSeconds: -1 });

        await service.reapExpiredShardLeases();

        expect((await shards())[0].status).toBe(status);
      },
    );

    it('takes the longest-stranded first and stops at the limit', async () => {
      // The ceiling only engages while catching up after a mass worker kill —
      // exactly when not flooding the database matters most.
      await seedShard({
        stage: STAGE_IDS.PROMOTE_PLACE,
        shardKey: 'a',
        status: SHARD_STATUS.RUNNING,
        leaseSeconds: -600,
      });
      await seedShard({
        stage: STAGE_IDS.PROMOTE_PLACE,
        shardKey: 'b',
        status: SHARD_STATUS.RUNNING,
        leaseSeconds: -300,
      });

      await expect(service.reapExpiredShardLeases(1)).resolves.toBe(1);

      const rows = await shards();
      expect(rows.find((row) => row.shard_key === 'a')?.status).toBe(SHARD_STATUS.PENDING);
      expect(rows.find((row) => row.shard_key === 'b')?.status).toBe(SHARD_STATUS.RUNNING);
    });

    it('reports zero on a healthy appliance', async () => {
      await seedShard({ stage: STAGE_IDS.PROMOTE_PLACE, status: SHARD_STATUS.RUNNING, leaseSeconds: 600 });

      await expect(service.reapExpiredShardLeases()).resolves.toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // The per-leg clock
  //
  // The whole gate rests on these two statements, and neither is observable
  // from a mock. `stageDueness` is pure and specced against fixed dates in
  // `schedule.spec`; what is NOT specced anywhere else is whether the instant it
  // is handed survives a round trip through Postgres's `timestamptz` — an
  // interval read back an hour wrong by a timezone is a weekly stage running
  // daily, and every mock in this file would agree with it.
  // -------------------------------------------------------------------------

  describe('the schedule clock', () => {
    let scheduleUser: string;

    beforeEach(() => {
      // A random user, never a real one: this suite rolls back, but a synthetic
      // row keyed to the appliance's own user would be visible to the live tick
      // for as long as the transaction is open.
      scheduleUser = randomUUID();
    });

    it('reports no row at all as never-run, which is what makes a fresh appliance enrich now', async () => {
      await expect(service.legScheduleFor(scheduleUser)).resolves.toEqual(new Map());
    });

    it('stamps a leg and reads the same instant back', async () => {
      const before = new Date();

      await service.recordStageStart(scheduleUser, leg(STAGE_IDS.ENRICH_GEOCODE));

      const schedule = await service.legScheduleFor(scheduleUser);
      const startedAt = schedule.get(`${STAGE_IDS.ENRICH_GEOCODE}\0event`);

      expect(startedAt).toBeInstanceOf(Date);
      // Within a second of now in BOTH directions. A timestamp that came back as
      // a local-time reading of a UTC value would be hours out and would still
      // be a perfectly valid Date — so the assertion is on the value, not the
      // type.
      expect(startedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
      expect(startedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    });

    it('keys a multi-type stage’s legs separately, so two sweeps keep two clocks', async () => {
      await service.recordStageStart(scheduleUser, leg(STAGE_IDS.INDEX_EMBED, 'event'));
      await service.recordStageStart(scheduleUser, leg(STAGE_IDS.INDEX_EMBED, 'communication'));

      const schedule = await service.legScheduleFor(scheduleUser);

      expect([...schedule.keys()].sort()).toEqual([
        `${STAGE_IDS.INDEX_EMBED}\0communication`,
        `${STAGE_IDS.INDEX_EMBED}\0event`,
      ]);
    });

    it('MOVES the stamp on a second claim rather than inserting a second row', async () => {
      // The `ON CONFLICT` arm, and the reason the interval is a real interval: a
      // second row per claim would make `legScheduleFor` return whichever one
      // Postgres felt like, including the oldest — a leg permanently overdue.
      await service.recordStageStart(scheduleUser, leg(STAGE_IDS.ENRICH_GEOCODE));

      const first = (await service.legScheduleFor(scheduleUser)).get(`${STAGE_IDS.ENRICH_GEOCODE}\0event`);

      // `now()` is transaction time and this suite runs inside ONE transaction,
      // so the two stamps are equal by design. What is under test is the row
      // count and the counter, which is what the upsert is for.
      await service.recordStageStart(scheduleUser, leg(STAGE_IDS.ENRICH_GEOCODE));

      const rows = (await runner.query(
        `SELECT stage, entity_type, starts, last_started_at
           FROM ci.pipeline_schedule
          WHERE user_id = $1::uuid`,
        [scheduleUser],
      )) as Array<{ starts: string | number; last_started_at: Date }>;

      expect(rows).toHaveLength(1);
      expect(Number(rows[0].starts)).toBe(2);
      expect(rows[0].last_started_at.getTime()).toBe(first?.getTime());
    });

    it('keeps one user’s clock out of another’s', async () => {
      // The property the whole per-leg design exists for: a second user's first
      // import must be due immediately regardless of how recently the first
      // user's pass ran.
      const other = randomUUID();

      await service.recordStageStart(scheduleUser, leg(STAGE_IDS.ENRICH_GEOCODE));

      await expect(service.legScheduleFor(other)).resolves.toEqual(new Map());
      expect((await service.legScheduleFor(scheduleUser)).size).toBe(1);
    });

    it('survives the round trip well enough for stageDueness to answer too_soon', async () => {
      // End to end, against the real column: stamp now, ask the real policy
      // function, and get the answer the schedule declares. This is the
      // assertion that would fail if `last_started_at` came back as a string or
      // in the wrong zone.
      await service.recordStageStart(scheduleUser, leg(STAGE_IDS.ENRICH_GEOCODE));

      const lastStartedAt =
        (await service.legScheduleFor(scheduleUser)).get(`${STAGE_IDS.ENRICH_GEOCODE}\0event`) ?? null;

      expect(
        stageDueness({ stageId: STAGE_IDS.ENRICH_GEOCODE, lastStartedAt, windowOpen: true }),
      ).toMatchObject({ due: false, reason: 'too_soon' });

      // And the other side of the same interval, from the same stored instant.
      const eightDaysOn = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

      expect(
        stageDueness({
          stageId: STAGE_IDS.ENRICH_GEOCODE,
          lastStartedAt,
          windowOpen: true,
          now: eightDaysOn,
        }),
      ).toMatchObject({ due: true, reason: 'interval_elapsed' });
    });
  });
});
