import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import {
  BaseEntity,
  CalendarEventService,
  EVENT_STATUS_REOPENER,
  EVENT_TIME_REOPENER,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
  calendarEventIdentity,
  type CreateEventDto,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';
import {
  HAPPENED,
  insertEvent,
  readEventLocations,
  WHERE_IT_WAS_TO_BE,
  WHERE_THE_USER_WAS,
  type EventLocation,
} from '../../__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { STAGE_IDS } from '../constants';
import { EventStatusReopenService } from '../services/EventStatusReopenService';
import { EventTimeReopenService } from '../services/EventTimeReopenService';
import { PipelineStateService } from '../services/PipelineStateService';
import type { StageRegistry } from '../services/StageRegistry';
import { TEMPORAL_REPAIR_VERSION, TemporalRepairStage } from '../stages/clean/TemporalRepairStage';
import { ESTIMATE_LOCATION_VERSION, EstimateLocationStage } from '../stages/enrich/EstimateLocationStage';
import type { Stage, StageResult } from '../types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A WRITE THAT IS NOT A SOURCE'S RE-DELIVERY SETTLES THE PIPELINE. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `CalendarEventService.update`, `.reschedule` and the status writes now ask
 * the pipeline to settle what it decided about an event's old time, and about
 * whether it happened (`EVENT_TIME_REOPENER`, `EVENT_STATUS_REOPENER`; the
 * memory-side spec, `CalendarEventService.pipelineDecisions`, says which writes
 * ask, with stand-ins for the bindings). This file runs the REAL ones — the
 * real service, ledger, `TemporalRepairStage` and `EstimateLocationStage` — and
 * pins what only they can show:
 *
 *  1. A person's move of a row the clean stage repaired. The stage writes the
 *     pre-repair instant `COALESCE(start_time_original, start_time)`, so an
 *     original the move left behind would be kept for good: the re-opened stage
 *     records the PERSON's instant as the one to undo to, not the old source
 *     one. The ledger is re-opened for both stages, and a save that merely
 *     repeats the stored time re-opens nothing.
 *  2. The estimator after a move: re-estimated from a donor near the NEW time,
 *     and, where none is near, still holding the old estimate. The stage never
 *     withdraws a coordinate, and this pins that limit.
 *  3. An event called off. A bare re-open of its ledger row does nothing for the
 *     estimate it was lent (the control below runs the premise): the sweep's
 *     applicability predicate never offers it, and a stage that is offered it
 *     anyway records a skip and writes nothing. So the writer of the status takes
 *     the estimate back, through each door — a person's `update`, a source's
 *     re-delivery, the thin `applyStatusFromSource` — and re-opens the ledger,
 *     and the reinstated event is offered again and estimated afresh.
 *  4. What it leaves alone: a coordinate that is the event's own, an estimate
 *     with a name beside it, a status change inside the live side, and a
 *     tombstone that is merely deleted.
 *
 * Opt-in like its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or the
 * `DATABASE_*` variables) to a migrated database, or run
 * `make test-db ARGS=EventWritesSettlePipeline`. Every fixture belongs to a
 * synthetic user and is deleted in `afterEach` and `afterAll`.
 */

const DATABASE_ENV = { urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/EventWritesSettlePipeline.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Far enough back that nothing real on a dev database is near it. */
const BASE = Date.parse('2019-03-04T12:00:00Z');
/** One window per fixture, three days apart: the estimator looks a day either way. */
const windowAt = (n: number): number => BASE + n * 3 * DAY_MS;

// An all-day event as the source stores it, and as the stage leaves it for a
// Pacific user in December (UTC-8).
const DAY = new Date('2026-12-25T00:00:00Z');
const NEXT_DAY = new Date('2026-12-26T00:00:00Z');
const DAY_LOCAL = new Date('2026-12-25T08:00:00Z');
const NEXT_DAY_LOCAL = new Date('2026-12-26T08:00:00Z');
// Where an API client drags it: UTC midnight, which the stage repairs again.
const PERSON_UTC_DAY = new Date('2026-12-30T00:00:00Z');
const PERSON_UTC_NEXT_DAY = new Date('2026-12-31T00:00:00Z');
const PERSON_LOCAL_DAY = new Date('2026-12-30T08:00:00Z');

const makeLogger = () => ({
  setContext: jest.fn(),
  log: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

interface EventState {
  status: string;
  title: string;
  start_time: Date;
  end_time: Date | null;
  time_source: string | null;
  time_precision: string | null;
  start_time_original: Date | null;
  end_time_original: Date | null;
  location_source: string | null;
  is_inferred: boolean;
  inference_sources: Record<string, unknown>;
  confidence_score: number;
  is_deleted: boolean;
}

interface LedgerRow {
  status: string;
  reason: string | null;
  stage_version: number;
}

describeWithDb(
  `the pipeline, settled by the writes that are not a re-delivery (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let ctx: UserServiceContext;

    let ledger: PipelineStateService;
    let temporal: TemporalRepairStage;
    let estimator: EstimateLocationStage;
    let service: CalendarEventService;

    let sequence = 0;

    const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);

    /** The sweep, claim, run and complete for one id, as the worker would. */
    async function sweepAndRun(stage: Stage, id: string): Promise<StageResult> {
      const stale = await ledger.selectStale(stage, ctx.userId, null, 1000);

      expect(stale).toContain(id);

      const claimed = await ledger.claim(stage, 'event', [id], ctx.userId);
      const outcome = await stage.run(ctx, claimed);
      await ledger.complete(stage, 'event', outcome);

      return outcome.get(id) as StageResult;
    }

    const offeredTo = async (stage: Stage): Promise<Set<string>> =>
      new Set(await ledger.selectStale(stage, ctx.userId, null, 1000));

    async function ledgerRow(id: string, stage: Stage): Promise<LedgerRow | undefined> {
      const [row] = (await query(
        `SELECT status, reason, stage_version FROM ci.pipeline_state
        WHERE entity_type = 'event' AND entity_id = $1 AND stage = $2`,
        [id, stage.id],
      )) as LedgerRow[];

      return row;
    }

    async function state(id: string): Promise<EventState> {
      const [row] = (await query(
        `SELECT e.status, b.name AS title, e.start_time, e.end_time, e.time_source, e.time_precision,
              e.start_time_original, e.end_time_original,
              e.metadata->>'location_source' AS location_source,
              e.is_inferred, e.inference_sources, e.confidence_score, e.is_deleted
         FROM ci.events e JOIN ci.entities b ON b.entity_id = e.event_id
        WHERE e.event_id = $1`,
        [id],
      )) as EventState[];

      return row;
    }

    async function locationOf(id: string): Promise<EventLocation> {
      return (await readEventLocations(query, [id])).get(id) as EventLocation;
    }

    async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
      const deadline = Date.now() + 10_000;

      while (Date.now() < deadline) {
        if (await predicate()) {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      throw new Error(`Timed out waiting for ${what}`);
    }

    /** Whether some backend is waiting on a lock `pid` holds. */
    async function someoneWaitsOn(pid: number): Promise<boolean> {
      const [{ waiting }] = (await query(
        'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [pid],
      )) as Array<{ waiting: number }>;

      return waiting > 0;
    }

    /** What a calendar connection sends for one meeting: the same identity every time. */
    function delivery(forUid: string, at: number, over: Partial<CreateEventDto> = {}): CreateEventDto {
      const identity = calendarEventIdentity(forUid);

      return {
        title: 'Offsite',
        event_type: 'calendar_event',
        start_time: new Date(at),
        status: 'confirmed',
        source_type: 'ETL',
        source_system: identity?.system,
        source_id: identity?.id,
        ...over,
      };
    }

    /** An unlocated calendar event, and a located one five minutes after it to lend it a coordinate. */
    async function seedEstimable(n: number): Promise<{ target: string; donor: string; at: number }> {
      const at = windowAt(n);
      const target = uuidv7();
      const donor = uuidv7();

      await insertEvent(query, ctx.userId, {
        id: target,
        title: `Target ${n}`,
        at,
        lifecycle: HAPPENED,
        point: null,
      });
      await insertEvent(query, ctx.userId, {
        id: donor,
        title: `Donor ${n}`,
        at: at + 5 * MINUTE_MS,
        lifecycle: HAPPENED,
        point: WHERE_IT_WAS_TO_BE,
      });

      return { target, donor, at };
    }

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        ...dataSourceConnection(DATABASE_ENV),
        entities: [EventEntity, BaseEntity, EventBaseEntity, UserEntity],
        synchronize: false,
        extra: { options: '-c search_path=ci,public' },
      });
      await dataSource.initialize();
      schemaLock = await acquireSchemaWriteLock(dataSource, 'pipeline/EventWritesSettlePipeline.integration');

      ctx = {
        userId: await createSyntheticTestUser(query, 'EventWritesSettlePipeline'),
      } as UserServiceContext;
      // The clean stage reconstructs an all-day event's local midnight from this.
      await query(`UPDATE ci.users SET timezone = 'America/Los_Angeles' WHERE id = $1`, [ctx.userId]);

      ledger = new PipelineStateService(dataSource, makeLogger() as never);
      temporal = new TemporalRepairStage(dataSource, makeLogger() as never);
      estimator = new EstimateLocationStage(dataSource, makeLogger() as never);

      const stages = new Map<string, Stage>([
        [STAGE_IDS.CLEAN_TEMPORAL_REPAIR, temporal],
        [STAGE_IDS.ENRICH_ESTIMATE_LOCATION, estimator],
      ]);
      const registry = { get: (id: string) => stages.get(id) } as unknown as StageRegistry;
      // The real bindings, over the real ledger, reached the way PipelineModule makes them reachable.
      const bindings: Record<string, unknown> = {
        [EVENT_TIME_REOPENER]: new EventTimeReopenService(ledger, registry),
        [EVENT_STATUS_REOPENER]: new EventStatusReopenService(ledger, registry),
      };

      service = new CalendarEventService(
        dataSource.getRepository(EventEntity),
        dataSource.getRepository(EventBaseEntity),
        { send: async () => undefined } as never,
        dataSource,
        new GraphDeltaWriter(dataSource, makeLogger() as never),
        { notifyEvents: async () => undefined } as never,
        { get: (token: string) => bindings[token] } as never,
      );
    });

    afterEach(async () => {
      await query(
        `DELETE FROM ci.pipeline_state
        WHERE entity_type = 'event' AND entity_id IN (SELECT event_id FROM ci.events WHERE user_id = $1)`,
        [ctx.userId],
      );
      await query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
      await query('DELETE FROM ci.record_sources WHERE user_id = $1', [ctx.userId]);
      await query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
      await query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    describe('a person moving an event the clean stage repaired', () => {
      /** A synced all-day event, repaired by the real stage for a Pacific user. */
      async function repairedAllDay(): Promise<string> {
        const [stored] = await service.create(
          ctx,
          delivery(`christmas-${uuidv7()}@example.test`, DAY.getTime(), {
            title: 'Christmas Day',
            end_time: NEXT_DAY,
            is_all_day: true,
          }),
        );

        const result = await sweepAndRun(temporal, stored.id);
        expect(result).toMatchObject({
          outcome: 'done',
          detail: { repairClass: 'floating_local_reconstructed' },
        });
        expect(await state(stored.id)).toMatchObject({
          start_time: DAY_LOCAL,
          end_time: NEXT_DAY_LOCAL,
          time_source: 'repaired',
          time_precision: 'day',
          start_time_original: DAY,
          end_time_original: NEXT_DAY,
        });
        expect(await ledgerRow(stored.id, temporal)).toMatchObject({
          status: 'done',
          stage_version: TEMPORAL_REPAIR_VERSION,
        });

        return stored.id;
      }

      it("records the person's instant as the one to undo to, not the source's old one", async () => {
        const id = await repairedAllDay();

        await service.update(ctx, id, { start_time: PERSON_UTC_DAY, end_time: PERSON_UTC_NEXT_DAY });

        // Before any sweep: the old record is gone, and the decision is open again.
        expect(await state(id)).toMatchObject({
          start_time: PERSON_UTC_DAY,
          time_source: null,
          time_precision: null,
          start_time_original: null,
          end_time_original: null,
        });
        expect(await ledgerRow(id, temporal)).toMatchObject({ status: 'done', stage_version: 0 });
        expect(await offeredTo(temporal)).toContain(id);

        // The stage looks at the new time and repairs it the way it repaired the first.
        await expect(sweepAndRun(temporal, id)).resolves.toMatchObject({
          outcome: 'done',
          detail: { repairClass: 'floating_local_reconstructed' },
        });

        // COALESCE(start_time_original, start_time) keeps the FIRST value ever
        // written, so an original the move had left would have survived this.
        expect(await state(id)).toMatchObject({
          start_time: PERSON_LOCAL_DAY,
          time_source: 'repaired',
          start_time_original: PERSON_UTC_DAY,
          end_time_original: PERSON_UTC_NEXT_DAY,
        });

        // The stage's documented undo restores what the person typed.
        await query(
          `UPDATE ci.events SET start_time = start_time_original
          WHERE start_time_original IS NOT NULL AND event_id = $1`,
          [id],
        );
        expect((await state(id)).start_time).toEqual(PERSON_UTC_DAY);
      });

      it("keeps the person's time when the source then speaks, whether it repeats or moves the event", async () => {
        const id = await repairedAllDay();
        await service.update(ctx, id, { start_time: PERSON_UTC_DAY, end_time: PERSON_UTC_NEXT_DAY });
        await sweepAndRun(temporal, id);
        const [stored] = (await query(`SELECT source_id FROM ci.events WHERE event_id = $1`, [id])) as Array<{
          source_id: string;
        }>;

        const sources = (at: Date, end: Date) =>
          service.create(
            ctx,
            delivery(stored.source_id, at.getTime(), {
              title: 'Christmas Day',
              end_time: end,
              is_all_day: true,
            }),
          );

        await sources(DAY, NEXT_DAY);
        await sources(new Date('2027-01-04T00:00:00Z'), new Date('2027-01-05T00:00:00Z'));

        expect(await state(id)).toMatchObject({
          start_time: PERSON_LOCAL_DAY,
          start_time_original: PERSON_UTC_DAY,
        });
      });

      it('re-opens the stage and the estimate through a drag too', async () => {
        const id = await repairedAllDay();
        await sweepAndRun(estimator, id);
        expect(await ledgerRow(id, estimator)).toMatchObject({ stage_version: ESTIMATE_LOCATION_VERSION });

        await service.reschedule(ctx, id, PERSON_UTC_DAY, PERSON_UTC_NEXT_DAY);

        expect(await ledgerRow(id, temporal)).toMatchObject({ status: 'done', stage_version: 0 });
        expect(await ledgerRow(id, estimator)).toMatchObject({ stage_version: 0 });
        expect(await state(id)).toMatchObject({ time_source: null, start_time_original: null });
      });

      it('re-opens nothing when a save repeats the stored time', async () => {
        const id = await repairedAllDay();
        await sweepAndRun(estimator, id);
        const before = await state(id);

        await service.update(ctx, id, {
          title: 'Christmas Day (renamed)',
          start_time: before.start_time,
          end_time: before.end_time as Date,
        });

        expect(await state(id)).toEqual({ ...before, title: 'Christmas Day (renamed)' });
        expect(await ledgerRow(id, temporal)).toMatchObject({ stage_version: TEMPORAL_REPAIR_VERSION });
        expect(await ledgerRow(id, estimator)).toMatchObject({ stage_version: ESTIMATE_LOCATION_VERSION });
        expect(await offeredTo(temporal)).not.toContain(id);
      });
    });

    describe('the location estimate of an event a person moved', () => {
      it('is recomputed from a donor near the new time', async () => {
        const { target, donor, at } = await seedEstimable((sequence += 1));
        const farAt = at + 10 * DAY_MS;
        const farDonor = uuidv7();
        await insertEvent(query, ctx.userId, {
          id: farDonor,
          title: 'Far donor',
          at: farAt + 5 * MINUTE_MS,
          lifecycle: HAPPENED,
          point: WHERE_THE_USER_WAS,
        });
        await sweepAndRun(estimator, target);
        expect(await locationOf(target)).toMatchObject({ locationSource: 'estimated', donorId: donor });

        await service.update(ctx, target, { start_time: new Date(farAt) });

        expect(await ledgerRow(target, estimator)).toMatchObject({ stage_version: 0 });
        await sweepAndRun(estimator, target);
        expect(await locationOf(target)).toMatchObject({ locationSource: 'estimated', donorId: farDonor });
      });

      it('stays where it was when no donor is near the new time: the stage never withdraws a coordinate', async () => {
        const { target, donor, at } = await seedEstimable((sequence += 1));
        await sweepAndRun(estimator, target);

        await service.update(ctx, target, { start_time: new Date(at + 10 * DAY_MS) });

        await expect(sweepAndRun(estimator, target)).resolves.toEqual({
          outcome: 'skipped',
          reason: 'no_donor_in_window',
        });
        // The limit, visible: the estimate describes a time the event no longer has.
        expect(await locationOf(target)).toMatchObject({ locationSource: 'estimated', donorId: donor });
      });
    });

    describe('an event called off after the estimator located it', () => {
      interface Door {
        name: string;
        /** An unlocated calendar event the estimator can locate, with its donor. */
        seed: (n: number) => Promise<{
          target: string;
          donor: string;
          cancel: () => Promise<unknown>;
          reinstate: () => Promise<unknown>;
        }>;
      }

      const doors: Door[] = [
        {
          name: "a person's update",
          seed: async (n) => {
            const { target, donor } = await seedEstimable(n);

            return {
              target,
              donor,
              cancel: () => service.update(ctx, target, { status: 'cancelled' }),
              reinstate: () => service.update(ctx, target, { status: 'confirmed' }),
            };
          },
        },
        {
          name: "its source's re-delivery",
          seed: async (n) => {
            const at = windowAt(n);
            const uid = `offsite-${uuidv7()}@example.test`;
            const [stored] = await service.create(ctx, delivery(uid, at));
            const donor = uuidv7();
            await insertEvent(query, ctx.userId, {
              id: donor,
              title: `Donor ${n}`,
              at: at + 5 * MINUTE_MS,
              lifecycle: HAPPENED,
              point: WHERE_IT_WAS_TO_BE,
            });

            return {
              target: stored.id,
              donor,
              cancel: () => service.create(ctx, delivery(uid, at, { status: 'cancelled' })),
              reinstate: () => service.create(ctx, delivery(uid, at, { status: 'confirmed' })),
            };
          },
        },
        {
          name: 'the thin cancellation a source sends (applyStatusFromSource)',
          seed: async (n) => {
            const at = windowAt(n);
            const uid = `offsite-${uuidv7()}@example.test`;
            const [stored] = await service.create(ctx, delivery(uid, at));
            const donor = uuidv7();
            await insertEvent(query, ctx.userId, {
              id: donor,
              title: `Donor ${n}`,
              at: at + 5 * MINUTE_MS,
              lifecycle: HAPPENED,
              point: WHERE_IT_WAS_TO_BE,
            });

            return {
              target: stored.id,
              donor,
              cancel: () => service.applyStatusFromSource(ctx, stored.id, 'cancelled'),
              reinstate: () => service.applyStatusFromSource(ctx, stored.id, 'confirmed'),
            };
          },
        },
      ];

      it.each(doors)(
        'loses the estimate to $name, and is estimated afresh when it is reinstated',
        async (door) => {
          const { target, donor, cancel, reinstate } = await door.seed((sequence += 1));
          await sweepAndRun(estimator, target);
          expect(await state(target)).toMatchObject({
            location_source: 'estimated',
            is_inferred: true,
            confidence_score: 0.4,
            inference_sources: expect.objectContaining({ method: 'temporal_nn', donor_id: donor }),
          });

          await cancel();

          // Taken back, as far as the row proves it was the estimator's.
          expect(await locationOf(target)).toEqual({
            lat: null,
            lng: null,
            locationSource: null,
            donorId: null,
          });
          const withdrawn = await state(target);
          expect(withdrawn).toMatchObject({
            status: 'cancelled',
            location_source: null,
            is_inferred: false,
            confidence_score: 1,
          });
          // `toMatchObject` reads `{}` as "any object".
          expect(withdrawn.inference_sources).toEqual({});
          // Re-opened, so that the reinstatement below is offered again...
          expect(await ledgerRow(target, estimator)).toMatchObject({ status: 'done', stage_version: 0 });
          // ...and not offered while it is called off.
          expect(await offeredTo(estimator)).not.toContain(target);

          await reinstate();

          expect(await state(target)).toMatchObject({ status: 'confirmed' });
          expect(await offeredTo(estimator)).toContain(target);
          await sweepAndRun(estimator, target);
          expect(await locationOf(target)).toMatchObject({ locationSource: 'estimated', donorId: donor });
        },
      );

      it("answers a person's cancellation with the event as it now stands, estimate gone", async () => {
        const { target } = await seedEstimable((sequence += 1));
        await sweepAndRun(estimator, target);

        const result = await service.update(ctx, target, { status: 'cancelled' });

        // The transaction wrote it after the reload `update` takes; the answer is
        // the row as the pipeline left it, not the one carrying the estimate.
        expect(result).toMatchObject({ status: 'cancelled', isInferred: false, locationCoordinates: null });
      });

      it('is not a thing the stage could have done alone: a bare re-open leaves the estimate where it was', async () => {
        const { target, donor } = await seedEstimable((sequence += 1));
        await sweepAndRun(estimator, target);

        // The status written by a writer that does not know about the contract,
        // and the ledger re-opened by hand: what wiring only the re-open would do.
        await query(`UPDATE ci.events SET status = 'cancelled' WHERE event_id = $1`, [target]);
        await ledger.reopen('event', estimator.id, [target]);

        // The sweep's applicability predicate does not offer it...
        expect(await offeredTo(estimator)).not.toContain(target);
        // ...and a stage that is offered it anyway writes nothing.
        const results = await estimator.run(ctx, [target]);
        expect(results.get(target)).toEqual({ outcome: 'skipped', reason: 'event_did_not_happen' });
        expect(await locationOf(target)).toMatchObject({ locationSource: 'estimated', donorId: donor });
      });

      it("re-opens only the called-off event's own ledger row", async () => {
        const first = await seedEstimable((sequence += 1));
        const second = await seedEstimable((sequence += 1));
        await sweepAndRun(estimator, first.target);
        await sweepAndRun(estimator, second.target);

        await service.update(ctx, first.target, { status: 'cancelled' });

        expect(await ledgerRow(first.target, estimator)).toMatchObject({ stage_version: 0 });
        expect(await ledgerRow(second.target, estimator)).toMatchObject({
          stage_version: ESTIMATE_LOCATION_VERSION,
        });
        expect(await locationOf(second.target)).toMatchObject({
          locationSource: 'estimated',
          donorId: second.donor,
        });
      });
    });

    describe('a slice that was already running when the event was called off', () => {
      it('does not put an estimate back over the cancellation', async () => {
        const { target } = await seedEstimable((sequence += 1));
        const runner = dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        let slice: Promise<Map<string, StageResult>> | undefined;

        try {
          const [{ pid }] = (await runner.query('SELECT pg_backend_pid() AS pid')) as Array<{ pid: number }>;
          // A status write before it commits: it holds the event's row.
          await runner.query(`UPDATE ci.events SET status = 'cancelled' WHERE event_id = $1`, [target]);

          // The slice loads the row as everyone else still sees it, live, and its
          // write then waits on that lock. Which is the interleaving that matters:
          // the cancellation, and what the writer withdraws with it, commit first.
          slice = estimator.run(ctx, [target]);
          await waitFor(() => someoneWaitsOn(pid), "the slice's write to wait on the cancellation");
        } finally {
          await runner.commitTransaction();
          await runner.release();
        }

        const results = await (slice as Promise<Map<string, StageResult>>);

        // The write re-checks, against the row's newest version, that it happened.
        expect(results.get(target)).toEqual({ outcome: 'skipped', reason: 'no_donor_in_window' });
        expect(await locationOf(target)).toEqual({
          lat: null,
          lng: null,
          locationSource: null,
          donorId: null,
        });
        expect((await state(target)).status).toBe('cancelled');
      });
    });

    describe('what a cancellation leaves alone', () => {
      /** A located calendar event, however it came by its coordinate, then cancelled by a person. */
      async function cancelledWith(
        n: number,
        location: { source: string | null; name: string | null; estimate: boolean },
      ): Promise<{ id: string; before: EventLocation }> {
        const id = uuidv7();
        await insertEvent(query, ctx.userId, {
          id,
          title: 'Offsite',
          at: windowAt(n),
          lifecycle: HAPPENED,
          point: WHERE_IT_WAS_TO_BE,
          locationName: location.name,
        });
        await query(
          `UPDATE ci.events
            SET metadata = CASE WHEN $2::text IS NULL THEN metadata
                                ELSE metadata || jsonb_build_object('location_source', $2::text) END,
                inference_sources = CASE WHEN $3::boolean
                                         THEN jsonb_build_object('method', 'temporal_nn') ELSE inference_sources END,
                is_inferred = $3::boolean,
                confidence_score = CASE WHEN $3::boolean THEN 0.4 ELSE confidence_score END
          WHERE event_id = $1`,
          [id, location.source, location.estimate],
        );
        const before = await locationOf(id);

        await service.update(ctx, id, { status: 'cancelled' });

        return { id, before };
      }

      it('takes the coordinate of an estimate with no name', async () => {
        const { id } = await cancelledWith((sequence += 1), {
          source: 'estimated',
          name: null,
          estimate: true,
        });

        expect(await locationOf(id)).toEqual({ lat: null, lng: null, locationSource: null, donorId: null });
      });

      it.each([
        [
          'an estimate with a name beside it, which a person typed after it was written',
          'estimated',
          'Studio 5',
          true,
        ],
        ["a coordinate geocoded from the event's own venue", 'geocoded', 'Studio 5', false],
        ['a coordinate geocoded with no name recorded', 'geocoded', null, false],
        ['a coordinate an importer wrote and nothing marks', null, null, false],
        ['a coarse coordinate the geocoder tagged approximate', 'approximate', null, false],
      ] as const)('keeps %s', async (_what, source, name, estimate) => {
        const { id, before } = await cancelledWith((sequence += 1), { source, name, estimate });

        expect(await locationOf(id)).toEqual(before);
        expect(await state(id)).toMatchObject({ status: 'cancelled', location_source: source });
      });

      it('keeps the estimate of an event it is told to settle that did happen: it decides from the row, not from the caller', async () => {
        const { target, donor } = await seedEstimable((sequence += 1));
        await sweepAndRun(estimator, target);
        // Called off by a writer that never told the pipeline, so the estimate is
        // still there: the residue the stage's own doc names.
        await query(`UPDATE ci.events SET status = 'cancelled' WHERE event_id = $1`, [target]);

        // The reinstatement asks. Nothing is withdrawn from an event that happened.
        await service.update(ctx, target, { status: 'confirmed' });

        expect(await locationOf(target)).toMatchObject({ locationSource: 'estimated', donorId: donor });
        expect(await ledgerRow(target, estimator)).toMatchObject({ stage_version: 0 });
      });

      it('keeps the estimate of an event whose status moved inside the live side, and does not re-open it', async () => {
        const { target, donor } = await seedEstimable((sequence += 1));
        await sweepAndRun(estimator, target);

        await service.update(ctx, target, { status: 'tentative' });

        expect(await locationOf(target)).toMatchObject({ locationSource: 'estimated', donorId: donor });
        expect(await ledgerRow(target, estimator)).toMatchObject({
          stage_version: ESTIMATE_LOCATION_VERSION,
        });
      });

      it('keeps the estimate of a tombstone that is merely deleted, and takes it from one its source cancels', async () => {
        const at = windowAt((sequence += 1));
        const uid = `offsite-${uuidv7()}@example.test`;
        const [stored] = await service.create(ctx, delivery(uid, at));
        const donor = uuidv7();
        await insertEvent(query, ctx.userId, {
          id: donor,
          title: 'Donor',
          at: at + 5 * MINUTE_MS,
          lifecycle: HAPPENED,
          point: WHERE_IT_WAS_TO_BE,
        });
        await sweepAndRun(estimator, stored.id);

        // Deleting changes no status, so a restore finds the row as it was.
        await service.remove(ctx, stored.id);
        expect(await locationOf(stored.id)).toMatchObject({ locationSource: 'estimated', donorId: donor });
        expect(await ledgerRow(stored.id, estimator)).toMatchObject({
          stage_version: ESTIMATE_LOCATION_VERSION,
        });

        // The source calls it off: as called off as any event, tombstone or not.
        await service.create(ctx, delivery(uid, at, { status: 'cancelled' }));

        expect(await state(stored.id)).toMatchObject({
          is_deleted: true,
          status: 'cancelled',
          location_source: null,
        });
        expect(await locationOf(stored.id)).toEqual({
          lat: null,
          lng: null,
          locationSource: null,
          donorId: null,
        });
      });
    });
  },
);
