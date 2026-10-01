import { DataSource, type EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { EventUpdatedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { EVENT_STATUSES } from '../../../__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { calendarEventIdentity } from '../../identity';
import type { CreateEventDto, UpdateEventDto } from '../../types';
import { CalendarEventService, DEAD_EVENT_STATUSES } from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { stubPipelineReopeners } from './harness/pipelineReopeners';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A WRITE THAT IS NOT A SOURCE'S RE-DELIVERY STILL HAS TO TELL THE PIPELINE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Stages decide on an event once and never look at the row again at that
 * version. #2898 made a source's move re-open them. A person's `update` or
 * `reschedule`, and a status that calls an event off, left them stale:
 *
 *  - `clean.temporal_repair` recorded `time_source = 'repaired'` and the
 *    pre-repair instant in `start_time_original`. A person's move left both, so
 *    the stage's documented undo (`SET start_time = start_time_original`) would
 *    put the old time back over theirs, and its next repair would keep the
 *    stale original (`COALESCE(start_time_original, start_time)`).
 *  - `enrich.estimate_location` lent a cancelled event a coordinate and kept it:
 *    its sweep never offers an event that did not happen again, and a stage that
 *    is offered one writes nothing.
 *
 * This file pins what the writers now do to real rows, with the pipeline's two
 * bindings (`EVENT_TIME_REOPENER`, `EVENT_STATUS_REOPENER`) stubbed so that it
 * can say what they were asked, when, and on which transaction. What the real
 * bindings do to the real ledger and the real stages is
 * `pipeline/__tests__/EventWritesSettlePipeline.integration.spec.ts`.
 *
 *  - Which writes ask, and which do not: a start or end that moved, against one a
 *    save merely repeats (the Plan page sends both times with every rename);
 *    a status that crossed the line between "still counts" and "called off", in
 *    either direction, against one that did not (all 81 pairs the table allows).
 *  - What the move does to the stage's record, and that `last_moved_at` is still
 *    stamped.
 *  - That the binding is asked on the write's own transaction, after the row has
 *    taken the new values, and that both commit or neither does.
 *  - That a service without the binding refuses a write that needs it, and does
 *    not need it for one that does not.
 *
 * Opt-in like the sibling integration specs: set MEMORY_TEST_DATABASE_URL to a
 * migrated database of your own.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/CalendarEventService.pipelineDecisions] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const START = new Date('2026-10-07T17:00:00Z');
const END = new Date('2026-10-07T18:00:00Z');
const MOVED_START = new Date('2026-10-09T15:00:00Z');
const MOVED_END = new Date('2026-10-09T16:30:00Z');

// An all-day event as the source stores it, and as `clean.temporal_repair`
// leaves it for a Pacific user (December: UTC-8).
const DAY = new Date('2026-12-25T00:00:00Z');
const NEXT_DAY = new Date('2026-12-26T00:00:00Z');
const DAY_LOCAL = new Date('2026-12-25T08:00:00Z');
const NEXT_DAY_LOCAL = new Date('2026-12-26T08:00:00Z');
// Where a person drags it.
const PERSON_DAY = new Date('2026-12-30T08:00:00Z');
const PERSON_NEXT_DAY = new Date('2026-12-31T08:00:00Z');

const TITLE = 'Quarterly review';

interface StoredRow {
  status: string;
  source_status: string | null;
  title: string | null;
  start_time: Date;
  end_time: Date | null;
  time_source: string | null;
  time_precision: string | null;
  start_time_original: Date | null;
  end_time_original: Date | null;
  last_moved_at: Date | null;
  is_deleted: boolean;
  updated_at: Date;
  ctid: string;
}

/** What a binding saw at the moment it was asked, through its own manager and through another connection. */
interface Observation {
  ids: readonly string[];
  /** Read on the manager the writer handed over: the transaction that wrote. */
  through: StoredRow;
  /** Read on a second connection: what the world sees until that transaction commits. */
  outside: StoredRow;
}

/** The ordered pairs of every status the table allows, with whether the move calls the event off or reinstates it. */
const STATUS_PAIRS = EVENT_STATUSES.flatMap((from) =>
  EVENT_STATUSES.map((to) => {
    const dead = (status: string) => (DEAD_EVENT_STATUSES as readonly string[]).includes(status);

    return [from, to, dead(from) !== dead(to)] as const;
  }),
);

describeWithDb(
  `CalendarEventService — what a write that is not a re-delivery tells the pipeline (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let service: CalendarEventService;
    /** The same service with no binding: how a container assembled without PipelineModule behaves. */
    let bare: CalendarEventService;
    let uid: string;

    const ctx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
    const signalling = { send: jest.fn(async () => undefined) };
    const hbpe = { notifyEvents: jest.fn(async () => undefined) };
    const pipeline = stubPipelineReopeners();
    const observed = { time: [] as Observation[], status: [] as Observation[] };
    const noopLogger = {
      setContext: () => undefined,
      log: () => undefined,
      debug: () => undefined,
      warn: () => undefined,
    } as unknown as LoggerService;

    /** What a calendar connection sends for one meeting: the same identity every time. */
    function delivery(over: Partial<CreateEventDto> = {}, forUid: string = uid): CreateEventDto {
      const identity = calendarEventIdentity(forUid);

      return {
        title: TITLE,
        event_type: 'calendar_event',
        start_time: START,
        end_time: END,
        status: 'confirmed',
        source_type: 'ETL',
        source_system: identity?.system,
        source_id: identity?.id,
        ...over,
      };
    }

    const SNAPSHOT_SQL = `SELECT e.status, e.source_status, b.name AS title, e.start_time, e.end_time,
              e.time_source, e.time_precision, e.start_time_original, e.end_time_original,
              e.last_moved_at, e.is_deleted, e.updated_at, e.ctid::text AS ctid
         FROM ci.events e JOIN ci.entities b ON b.entity_id = e.event_id
        WHERE e.event_id = $1`;

    async function snapshot(runner: Pick<EntityManager, 'query'>, id: string): Promise<StoredRow> {
      const [found] = await runner.query(SNAPSHOT_SQL, [id]);

      return found;
    }

    const row = (id: string): Promise<StoredRow> => snapshot(dataSource, id);

    /** A synced all-day event, then what `clean.temporal_repair` does to it for a Pacific user. */
    async function repairedAllDay(label: 'repaired' | 'source' = 'repaired', forUid: string = uid) {
      const [stored] = await service.create(
        ctx,
        delivery({ start_time: DAY, end_time: NEXT_DAY, is_all_day: true }, forUid),
      );
      await dataSource.query(
        `UPDATE ci.events
            SET start_time = $2, end_time = $3, time_source = $4, time_precision = 'day',
                start_time_original = $5, end_time_original = $6
          WHERE event_id = $1`,
        [stored.id, DAY_LOCAL, NEXT_DAY_LOCAL, label, DAY, NEXT_DAY],
      );
      jest.clearAllMocks();

      return stored.id;
    }

    /** The stage's own one-line undo, as TemporalRepairStage documents it. */
    function undoRepairs(id: string): Promise<unknown> {
      return dataSource.query(
        `UPDATE ci.events SET start_time = start_time_original
          WHERE start_time_original IS NOT NULL AND event_id = $1`,
        [id],
      );
    }

    /** A source-owned event that holds `status`, whatever its source said first. */
    async function eventWithStatus(status: string): Promise<string> {
      const [stored] = await service.create(ctx, delivery({ status }, `status-${uuidv7()}@example.test`));
      jest.clearAllMocks();

      return stored.id;
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
      schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/CalendarEventService.pipelineDecisions');

      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
         VALUES ($1, 'Pipeline decisions fixture', $2, 'x', true, 'America/Los_Angeles')`,
        [ctx.userId, `pipeline-decisions.${ctx.userId}@example.test`],
      );

      const build = (moduleRef?: unknown) =>
        new CalendarEventService(
          dataSource.getRepository(EventEntity),
          dataSource.getRepository(EventBaseEntity),
          signalling as never,
          dataSource,
          new GraphDeltaWriter(dataSource, noopLogger),
          hbpe as never,
          moduleRef as never,
        );

      service = build(pipeline.moduleRef);
      bare = build();
    });

    beforeEach(() => {
      jest.clearAllMocks();
      observed.time.length = 0;
      observed.status.length = 0;
      uid = `review-${uuidv7()}@example.test`;

      // Each binding records what it was asked, and what the row looked like to
      // the transaction that asked and to everyone else at that moment.
      pipeline.time.reopenTimeDecisions.mockImplementation(async (...args: unknown[]) => {
        const [ids, manager] = args as [readonly string[], EntityManager];
        observed.time.push({
          ids,
          through: await snapshot(manager, ids[0]),
          outside: await row(ids[0]),
        });

        return 0;
      });
      pipeline.status.reopenStatusDecisions.mockImplementation(async (...args: unknown[]) => {
        const [ids, manager] = args as [readonly string[], EntityManager];
        observed.status.push({
          ids,
          through: await snapshot(manager, ids[0]),
          outside: await row(ids[0]),
        });

        return 0;
      });
    });

    afterEach(async () => {
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    describe("a person moving an event's time", () => {
      it("clears the clean stage's record of the old time and re-opens its decisions, on the move's own transaction", async () => {
        const id = await repairedAllDay();

        const moved = await service.update(ctx, id, { start_time: PERSON_DAY, end_time: PERSON_NEXT_DAY });

        const after = await row(id);
        expect(after).toMatchObject({
          start_time: PERSON_DAY,
          end_time: PERSON_NEXT_DAY,
          time_source: null,
          time_precision: null,
          start_time_original: null,
          end_time_original: null,
        });
        // The stamp stays: it is how the source merge tells a person's move from the stage's.
        expect(after.last_moved_at).toBeInstanceOf(Date);
        // The answer is the row as it stands, not the one the move replaced.
        expect(moved).toMatchObject({
          startTime: PERSON_DAY,
          timeSource: null,
          timePrecision: null,
        });

        expect(pipeline.time.reopenTimeDecisions).toHaveBeenCalledTimes(1);
        expect(pipeline.time.reopenTimeDecisions).toHaveBeenCalledWith([id], expect.anything());
        expect(pipeline.status.reopenStatusDecisions).not.toHaveBeenCalled();

        // Asked after the row took the new values, on the transaction that wrote
        // them: it saw the move and the cleared record, and nobody else did yet.
        const [seen] = observed.time;
        expect(seen.through).toMatchObject({
          start_time: PERSON_DAY,
          time_source: null,
          time_precision: null,
          start_time_original: null,
          end_time_original: null,
        });
        expect(seen.outside).toMatchObject({
          start_time: DAY_LOCAL,
          time_source: 'repaired',
          time_precision: 'day',
          start_time_original: DAY,
          end_time_original: NEXT_DAY,
        });
      });

      it("leaves the stage's documented undo nothing to put back over the person's time", async () => {
        // The control: an untouched repair, which the undo does reverse.
        const control = await repairedAllDay('repaired', `control-${uuidv7()}@example.test`);
        await undoRepairs(control);
        expect((await row(control)).start_time).toEqual(DAY);

        const id = await repairedAllDay();
        await service.update(ctx, id, { start_time: PERSON_DAY, end_time: PERSON_NEXT_DAY });
        await undoRepairs(id);

        expect((await row(id)).start_time).toEqual(PERSON_DAY);
      });

      it('settles a move of the end alone', async () => {
        const [stored] = await service.create(ctx, delivery());
        await dataSource.query(
          `UPDATE ci.events SET time_source = 'source', time_precision = 'second' WHERE event_id = $1`,
          [stored.id],
        );
        const stretched = new Date('2026-10-07T19:00:00Z');

        await service.update(ctx, stored.id, { end_time: stretched });

        expect(await row(stored.id)).toMatchObject({
          start_time: START,
          end_time: stretched,
          time_source: null,
          time_precision: null,
        });
        expect(pipeline.time.reopenTimeDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
      });

      it('settles a move that makes an event open-ended', async () => {
        const [stored] = await service.create(ctx, delivery());
        jest.clearAllMocks();

        // The GraphQL input is nullable; the DTO's type does not say so.
        await service.update(ctx, stored.id, { end_time: null } as unknown as UpdateEventDto);

        expect((await row(stored.id)).end_time).toBeNull();
        expect(pipeline.time.reopenTimeDecisions).toHaveBeenCalledTimes(1);
      });

      it('dates an event the importer could only stamp, and no longer calls its time unknown', async () => {
        const [stored] = await service.create(
          ctx,
          delivery({ time_source: 'ingest', time_precision: 'unknown' }),
        );
        expect(await row(stored.id)).toMatchObject({ time_source: 'ingest', time_precision: 'unknown' });

        await service.update(ctx, stored.id, { start_time: MOVED_START, end_time: MOVED_END });

        // `ingest` + `unknown` is what makes a card say "date unknown".
        expect(await row(stored.id)).toMatchObject({ time_source: null, time_precision: null });
      });

      it("moves an event no source owns the same way: nothing here tells a person's events apart", async () => {
        const [own] = await service.create(ctx, { title: 'My own event', start_time: START, end_time: END });
        jest.clearAllMocks();

        await service.update(ctx, own.id, { start_time: MOVED_START, end_time: MOVED_END });

        expect(pipeline.time.reopenTimeDecisions).toHaveBeenCalledWith([own.id], expect.anything());
      });

      it("moves nothing when a rename repeats the stored times, as the Plan page's edit sends them", async () => {
        const id = await repairedAllDay();
        const before = await row(id);

        await service.update(ctx, id, {
          title: 'Christmas Day (renamed)',
          start_time: before.start_time,
          end_time: before.end_time as Date,
        });

        const after = await row(id);
        // The record of a repair that still holds is not erased...
        expect(after).toMatchObject({
          title: 'Christmas Day (renamed)',
          start_time: DAY_LOCAL,
          time_source: 'repaired',
          time_precision: 'day',
          start_time_original: DAY,
          end_time_original: NEXT_DAY,
        });
        // ...and the stage is not asked to look again.
        expect(pipeline.time.reopenTimeDecisions).not.toHaveBeenCalled();
        // The stamp is written for such a save all the same, as it always was.
        expect(after.last_moved_at).toBeInstanceOf(Date);
      });

      it('does not touch what the stage recorded when the patch names no time', async () => {
        const id = await repairedAllDay();

        await service.update(ctx, id, { description: 'Presents under the tree', category: 'family' });

        expect(await row(id)).toMatchObject({
          time_source: 'repaired',
          start_time_original: DAY,
          last_moved_at: null,
        });
        expect(pipeline.time.reopenTimeDecisions).not.toHaveBeenCalled();
      });

      it('settles a drag, and returns the event as it stands', async () => {
        const id = await repairedAllDay();

        const moved = await service.reschedule(ctx, id, PERSON_DAY, PERSON_NEXT_DAY);

        const after = await row(id);
        expect(after).toMatchObject({
          start_time: PERSON_DAY,
          end_time: PERSON_NEXT_DAY,
          time_source: null,
          time_precision: null,
          start_time_original: null,
          end_time_original: null,
        });
        expect(after.last_moved_at).toBeInstanceOf(Date);
        expect(moved).toMatchObject({ startTime: PERSON_DAY, timeSource: null });
        expect(pipeline.time.reopenTimeDecisions).toHaveBeenCalledTimes(1);

        const [seen] = observed.time;
        expect(seen.through).toMatchObject({ start_time: PERSON_DAY, time_source: null });
        expect(seen.outside).toMatchObject({ start_time: DAY_LOCAL, time_source: 'repaired' });
      });

      it('leaves a record alone when a drag drops the event on the slot it already holds', async () => {
        const id = await repairedAllDay();

        // Same start, and the end follows at the prior span: the same slot.
        await service.reschedule(ctx, id, DAY_LOCAL);

        expect(await row(id)).toMatchObject({
          start_time: DAY_LOCAL,
          end_time: NEXT_DAY_LOCAL,
          time_source: 'repaired',
          start_time_original: DAY,
        });
        expect(pipeline.time.reopenTimeDecisions).not.toHaveBeenCalled();
        expect((await row(id)).last_moved_at).toBeInstanceOf(Date);
      });

      it.each([
        [
          'update',
          (id: string) =>
            service.update(ctx, id, {
              title: 'Renamed too',
              start_time: PERSON_DAY,
              end_time: PERSON_NEXT_DAY,
            }),
        ],
        ['reschedule', (id: string) => service.reschedule(ctx, id, PERSON_DAY, PERSON_NEXT_DAY)],
      ])('%s commits the move and the re-open together, or neither', async (_door, move) => {
        const id = await repairedAllDay();
        const before = await row(id);
        pipeline.time.reopenTimeDecisions.mockImplementation(async () => {
          throw new Error('pipeline unavailable');
        });

        await expect(move(id)).rejects.toThrow('pipeline unavailable');

        // Rolled back whole: the time, the stage's record, the stamp and the rename.
        expect(await row(id)).toEqual(before);
        expect(signalling.send).not.toHaveBeenCalled();
      });

      it('refuses a move it cannot settle in a container with no binding, and leaves the row alone', async () => {
        const id = await repairedAllDay();
        const before = await row(id);

        await expect(
          bare.update(ctx, id, { start_time: PERSON_DAY, end_time: PERSON_NEXT_DAY }),
        ).rejects.toThrow(/EVENT_TIME_REOPENER/);
        await expect(bare.reschedule(ctx, id, PERSON_DAY, PERSON_NEXT_DAY)).rejects.toThrow(
          /EVENT_TIME_REOPENER/,
        );

        expect(await row(id)).toEqual(before);
      });

      it('needs no binding for a write that moves nothing', async () => {
        const id = await repairedAllDay();
        const before = await row(id);

        await expect(bare.update(ctx, id, { title: 'Renamed' })).resolves.toMatchObject({ title: 'Renamed' });
        await expect(
          bare.update(ctx, id, { start_time: before.start_time, end_time: before.end_time as Date }),
        ).resolves.toBeTruthy();
        await expect(bare.reschedule(ctx, id, DAY_LOCAL)).resolves.toBeTruthy();
      });
    });

    describe('an event called off, or reinstated', () => {
      it('asks when a person cancels it, on the status write’s own transaction', async () => {
        const id = await eventWithStatus('confirmed');

        const cancelled = await service.update(ctx, id, { status: 'cancelled' });

        expect(cancelled?.status).toBe('cancelled');
        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledTimes(1);
        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledWith([id], expect.anything());
        // A status is not a move.
        expect(pipeline.time.reopenTimeDecisions).not.toHaveBeenCalled();

        const [seen] = observed.status;
        expect(seen.through).toMatchObject({ status: 'cancelled' });
        expect(seen.outside).toMatchObject({ status: 'confirmed' });
      });

      it('asks when a person reinstates it', async () => {
        const id = await eventWithStatus('cancelled');

        await service.update(ctx, id, { status: 'confirmed' });

        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledWith([id], expect.anything());
      });

      it.each(STATUS_PAIRS)(
        'update from %s to %s asks only if it crossed the line between counting and called off (%s)',
        async (from, to, crosses) => {
          const id = await eventWithStatus(from);

          await service.update(ctx, id, { status: to });

          expect((await row(id)).status).toBe(to);
          expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledTimes(crosses ? 1 : 0);
        },
      );

      it('does not ask when the patch names no status', async () => {
        const id = await eventWithStatus('cancelled');

        await service.update(ctx, id, { title: 'Still cancelled' });

        expect(pipeline.status.reopenStatusDecisions).not.toHaveBeenCalled();
      });

      it('asks once, and for both, when one patch moves an event and calls it off', async () => {
        const id = await repairedAllDay();

        const result = await service.update(ctx, id, {
          start_time: PERSON_DAY,
          end_time: PERSON_NEXT_DAY,
          status: 'cancelled',
        });

        expect(pipeline.time.reopenTimeDecisions).toHaveBeenCalledTimes(1);
        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledTimes(1);
        // One transaction: each binding sees the other's write too.
        expect(observed.time[0].through).toMatchObject({ status: 'cancelled', start_time: PERSON_DAY });
        expect(observed.status[0].through).toMatchObject({ status: 'cancelled', time_source: null });
        expect(result).toMatchObject({ status: 'cancelled', timeSource: null });
      });

      it('asks when the source cancels it, and when the source reinstates it', async () => {
        const [stored] = await service.create(ctx, delivery());
        jest.clearAllMocks();

        await service.create(ctx, delivery({ status: 'cancelled' }));

        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledTimes(1);
        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
        expect(observed.status[0].through).toMatchObject({ status: 'cancelled', source_status: 'cancelled' });
        expect(observed.status[0].outside).toMatchObject({ status: 'confirmed', source_status: 'confirmed' });
        expect(pipeline.time.reopenTimeDecisions).not.toHaveBeenCalled();

        jest.clearAllMocks();
        await service.create(ctx, delivery({ status: 'confirmed' }));

        expect((await row(stored.id)).status).toBe('confirmed');
        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledTimes(1);
      });

      it('asks through the door for a re-delivery too thin to create with', async () => {
        const [stored] = await service.create(ctx, delivery());
        jest.clearAllMocks();

        const result = await service.applyStatusFromSource(ctx, stored.id, 'cancelled');

        expect(result?.status).toBe('cancelled');
        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledTimes(1);
        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
      });

      it('does not ask when the source repeats itself, or when the status a person set stands', async () => {
        const [stored] = await service.create(ctx, delivery());
        jest.clearAllMocks();

        await service.create(ctx, delivery());
        expect(pipeline.status.reopenStatusDecisions).not.toHaveBeenCalled();

        // The person calls it a no-show (asked once, for their own write)...
        await service.update(ctx, stored.id, { status: 'no_show' });
        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledTimes(1);
        jest.clearAllMocks();

        // ...and the organizer's later word does not move it, so nothing is asked.
        await service.create(ctx, delivery({ status: 'tentative' }));
        expect(await row(stored.id)).toMatchObject({ status: 'no_show', source_status: 'tentative' });
        expect(pipeline.status.reopenStatusDecisions).not.toHaveBeenCalled();
      });

      it('does not ask when a source moves a status inside the live side', async () => {
        const [stored] = await service.create(ctx, delivery());
        jest.clearAllMocks();

        await service.create(ctx, delivery({ status: 'tentative' }));

        expect((await row(stored.id)).status).toBe('tentative');
        expect(pipeline.status.reopenStatusDecisions).not.toHaveBeenCalled();
      });

      it('asks for a tombstone the source cancels, quietly: nothing is published', async () => {
        const [stored] = await service.create(ctx, delivery());
        await service.remove(ctx, stored.id);
        jest.clearAllMocks();

        await service.create(ctx, delivery({ status: 'cancelled' }));

        expect(await row(stored.id)).toMatchObject({ status: 'cancelled', is_deleted: true });
        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledTimes(1);
        expect(pipeline.status.reopenStatusDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
        expect(signalling.send).not.toHaveBeenCalledWith(EventUpdatedEvent, expect.anything());
      });

      it.each([
        ['update', (id: string) => service.update(ctx, id, { status: 'cancelled', title: 'Cancelled too' })],
        ['a re-delivery', (_id: string) => service.create(ctx, delivery({ status: 'cancelled' }))],
        ['applyStatusFromSource', (id: string) => service.applyStatusFromSource(ctx, id, 'cancelled')],
      ])('%s commits the status and the settling together, or neither', async (_door, cancel) => {
        const [stored] = await service.create(ctx, delivery());
        const before = await row(stored.id);
        jest.clearAllMocks();
        pipeline.status.reopenStatusDecisions.mockImplementation(async () => {
          throw new Error('pipeline unavailable');
        });

        await expect(cancel(stored.id)).rejects.toThrow('pipeline unavailable');

        expect(await row(stored.id)).toEqual(before);
      });

      it('refuses a cancellation it cannot settle in a container with no binding, and needs none otherwise', async () => {
        const [stored] = await service.create(ctx, delivery());
        const before = await row(stored.id);

        await expect(bare.update(ctx, stored.id, { status: 'cancelled' })).rejects.toThrow(
          /EVENT_STATUS_REOPENER/,
        );
        await expect(bare.create(ctx, delivery({ status: 'cancelled' }))).rejects.toThrow(
          /EVENT_STATUS_REOPENER/,
        );
        expect(await row(stored.id)).toEqual(before);

        // Inside the live side it never needed one.
        await expect(bare.update(ctx, stored.id, { status: 'tentative' })).resolves.toMatchObject({
          status: 'tentative',
        });
      });
    });
  },
);
