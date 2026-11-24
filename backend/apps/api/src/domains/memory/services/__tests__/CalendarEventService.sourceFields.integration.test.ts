import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { EventUpdatedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { calendarEventIdentity, platformIdentity } from '../../identity';
import { clearExpansionZoneCache } from '../../recurrence/queries';
import type { CreateEventDto } from '../../types';
import { CalendarEventService } from '../CalendarEventService';
import { EVENT_STATUS_REOPENER } from '../eventStatusReopener';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SOURCE'S RE-DELIVERED TIME AND TITLE, AGAINST THE ROWS THEY LAND ON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `createOne` refreshed only `status` (#2890), so a meeting the organizer moved
 * or renamed kept its first-sync time and title for good. It now merges the
 * time (start, end and a series' rule, as one unit) and the title three ways
 * against what the source delivered last time (sourceFieldMerge.ts has the
 * rule; the sibling sourceStatus suite covers `status`). This file pins what
 * that does to real rows, through `create`, the door every connection uses:
 *
 *  - what lands and who hears about it: the graph delta, the update event, HBPE
 *    for both days a move touches, and the re-open of the pipeline's decisions
 *    on the old time — or, for a tombstone, only the re-open;
 *  - that a user's move or rename stands, including one that commits while the
 *    sync waits on a lock (two live connections and a `pg_blocking_pids`
 *    rendezvous, which is why this is not a unit spec);
 *  - that a row the clean stage repaired follows its source without the repair
 *    being undone on every sync;
 *  - what read-time expansion makes of an override row, or a series, that moves;
 *  - and that every write to an event takes the event row's lock before its
 *    base row's, so a sync's rename cannot deadlock a user's.
 *
 * Opt-in like the sibling integration specs: set MEMORY_TEST_DATABASE_URL to a
 * migrated database of your own.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/CalendarEventService.sourceFields] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const START = new Date('2026-10-07T17:00:00Z');
const END = new Date('2026-10-07T18:00:00Z');
// Where the organizer moves it.
const MOVED_START = new Date('2026-10-09T15:00:00Z');
const MOVED_END = new Date('2026-10-09T16:30:00Z');
// Where the user puts it.
const USER_START = new Date('2026-10-08T13:00:00Z');
const USER_END = new Date('2026-10-08T14:00:00Z');

const TITLE = 'Quarterly review';

interface StoredRow {
  start_time: Date;
  end_time: Date | null;
  status: string;
  title: string | null;
  source_start_time: Date | null;
  source_end_time: Date | null;
  source_recurrence: { rule: unknown; timeZone: string | null } | null;
  source_title: string | null;
  time_source: string | null;
  time_precision: string | null;
  start_time_original: Date | null;
  end_time_original: Date | null;
  last_moved_at: Date | null;
  external_sync_status: string | null;
  is_deleted: boolean;
  is_all_day: boolean;
  is_recurring: boolean;
  metadata: Record<string, unknown>;
  updated_at: Date;
  ctid: string;
  base_ctid: string;
}

describeWithDb(
  `CalendarEventService — a source re-delivering a time and a title (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let service: CalendarEventService;
    let uid: string;

    const ctx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
    const signalling = { send: jest.fn(async () => undefined) };
    const hbpe = { notifyEvents: jest.fn(async () => undefined) };
    // What PipelineModule binds to EVENT_TIME_REOPENER. Here, only whether it
    // was asked, and on which transaction.
    const reopener = { reopenTimeDecisions: jest.fn(async () => 0) };
    // And EVENT_STATUS_REOPENER, which a delivery that cancels the event asks.
    const statusReopener = { reopenStatusDecisions: jest.fn(async () => 0) };
    const noopLogger = {
      setContext: () => undefined,
      log: () => undefined,
      debug: () => undefined,
      warn: () => undefined,
    } as unknown as LoggerService;

    /** What a calendar connection sends for one meeting: the same identity every time. */
    function delivery(over: Partial<CreateEventDto> = {}, recurrenceId?: string): CreateEventDto {
      const identity = calendarEventIdentity(uid, recurrenceId);

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

    async function row(id: string): Promise<StoredRow> {
      const [found] = await dataSource.query(
        `SELECT e.start_time, e.end_time, e.status, b.name AS title,
              e.source_start_time, e.source_end_time, e.source_recurrence, e.source_title,
              e.time_source, e.time_precision, e.start_time_original, e.end_time_original,
              e.last_moved_at, e.external_sync_status, e.is_deleted, e.is_all_day, e.is_recurring,
              e.metadata, e.updated_at, e.ctid::text AS ctid, b.ctid::text AS base_ctid
         FROM ci.events e JOIN ci.entities b ON b.entity_id = e.event_id
        WHERE e.event_id = $1`,
        [id],
      );

      return found;
    }

    function refreshDeltas(
      id: string,
    ): Promise<Array<{ changed_fields: Record<string, unknown>; changed_by_user_id: unknown }>> {
      return dataSource.query(
        `SELECT changed_fields, changed_by_user_id FROM ci.graph_deltas
        WHERE entity_id = $1 AND change_source = 'CalendarEventService.refreshFromSource'
        ORDER BY changed_at`,
        [id],
      );
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
      const [{ waiting }] = await dataSource.query(
        'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [pid],
      );

      return waiting > 0;
    }

    /**
     * Run `hold` in a transaction on its own connection, then `whileHeld` while
     * that transaction is still open, then commit. Returns `whileHeld`'s result.
     */
    async function withOpenTransaction<T>(
      hold: (query: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>,
      whileHeld: (pid: number) => Promise<T>,
    ): Promise<T> {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();

      try {
        const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid');
        await hold((sql, params) => runner.query(sql, params));
        const result = await whileHeld(pid);

        return result;
      } finally {
        if (runner.isTransactionActive) {
          await runner.commitTransaction();
        }

        await runner.release();
      }
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
      schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/CalendarEventService.sourceFields');

      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Source fields fixture', $2, 'x', true, 'UTC')`,
        [ctx.userId, `source-fields.${ctx.userId}@example.test`],
      );

      service = new CalendarEventService(
        dataSource.getRepository(EventEntity),
        dataSource.getRepository(EventBaseEntity),
        signalling as never,
        dataSource,
        new GraphDeltaWriter(dataSource, noopLogger),
        hbpe as never,
        { get: (token: string) => (token === EVENT_STATUS_REOPENER ? statusReopener : reopener) } as never,
      );
    });

    beforeEach(() => {
      jest.clearAllMocks();
      reopener.reopenTimeDecisions.mockImplementation(async () => 0);
      clearExpansionZoneCache();
      uid = `review-${uuidv7()}@example.test`;
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

    describe('what an insert records', () => {
      it("records the source's time, rule and title beside the row, through both doors", async () => {
        const rule = ['RRULE:FREQ=WEEKLY;BYDAY=WE'];
        const [single] = await service.create(
          ctx,
          delivery({
            metadata: { recurrenceRule: rule, recurrenceTimeZone: 'Europe/London' },
            is_recurring: true,
          }),
        );

        expect(await row(single.id)).toMatchObject({
          source_start_time: START,
          source_end_time: END,
          source_recurrence: { rule, timeZone: 'Europe/London' },
          source_title: TITLE,
        });

        // The importer's push: the set-based INSERT records the same bases...
        uid = `import-${uuidv7()}@example.test`;
        const [bulk] = await service.create(ctx, [
          delivery({ source_type: 'ci-import-tools', end_time: undefined }),
        ]);

        expect(await row(bulk.id)).toMatchObject({
          source_start_time: START,
          source_end_time: null,
          source_recurrence: null,
          source_title: TITLE,
        });

        // ...and still refreshes nothing on a conflict: the bulk door is
        // find-or-return (INGEST_REFRESH_COLUMNS.event is empty).
        await service.create(ctx, [
          delivery({
            source_type: 'ci-import-tools',
            start_time: MOVED_START,
            end_time: MOVED_END,
            title: 'Moved',
          }),
        ]);

        expect(await row(bulk.id)).toMatchObject({
          start_time: START,
          title: TITLE,
          source_start_time: START,
        });
      });

      it('records no base on a row no source owns, nor on a planned block', async () => {
        const [own] = await service.create(ctx, { title: 'My own event', start_time: START, end_time: END });
        const identity = platformIdentity('planning', 'task', uuidv7());
        const [block] = await service.create(ctx, {
          title: 'Write the memo',
          event_type: 'planned_block',
          start_time: START,
          end_time: END,
          status: 'planned',
          source_type: 'planning',
          source_system: identity.system,
          source_id: identity.id,
        });

        for (const id of [own.id, block.id]) {
          expect(await row(id)).toMatchObject({
            source_start_time: null,
            source_end_time: null,
            source_title: null,
          });
        }
      });
    });

    describe('a source moving or renaming the event', () => {
      it('moves a meeting its organizer moved, and publishes what update publishes', async () => {
        const [stored] = await service.create(ctx, delivery());
        jest.clearAllMocks();

        const [resynced] = await service.create(
          ctx,
          delivery({ start_time: MOVED_START, end_time: MOVED_END }),
        );

        expect(resynced.id).toBe(stored.id);
        expect(resynced.startTime).toEqual(MOVED_START);
        expect(await row(stored.id)).toMatchObject({
          start_time: MOVED_START,
          end_time: MOVED_END,
          source_start_time: MOVED_START,
          source_end_time: MOVED_END,
          // A person's move is what this column records, and nobody moved it.
          last_moved_at: null,
          external_sync_status: null,
        });

        expect(signalling.send).toHaveBeenCalledTimes(1);
        expect(signalling.send).toHaveBeenCalledWith(EventUpdatedEvent, { eventId: stored.id });
        // Both days: the one it left and the one it lands on.
        expect(hbpe.notifyEvents).toHaveBeenCalledTimes(1);
        expect(hbpe.notifyEvents).toHaveBeenCalledWith(ctx.userId, [START, MOVED_START]);
        expect(reopener.reopenTimeDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
        expect(await refreshDeltas(stored.id)).toEqual([
          {
            changed_fields: expect.objectContaining({
              start_time: { old: START.toISOString(), new: MOVED_START.toISOString() },
              end_time: { old: END.toISOString(), new: MOVED_END.toISOString() },
            }),
            // The source changed it, not the user.
            changed_by_user_id: null,
          },
        ]);
      });

      it('renames a meeting its organizer renamed', async () => {
        const [stored] = await service.create(ctx, delivery());
        const before = await row(stored.id);
        jest.clearAllMocks();

        const [resynced] = await service.create(ctx, delivery({ title: 'Quarterly review (moved to Q4)' }));

        expect(resynced.title).toBe('Quarterly review (moved to Q4)');
        const after = await row(stored.id);
        expect(after).toMatchObject({
          title: 'Quarterly review (moved to Q4)',
          source_title: 'Quarterly review (moved to Q4)',
        });
        // The detail row's watermark moves too, as `update` moves it for a rename.
        expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
        expect(signalling.send).toHaveBeenCalledWith(EventUpdatedEvent, { eventId: stored.id });
        expect(hbpe.notifyEvents).toHaveBeenCalledWith(ctx.userId, START);
        // A rename is not a move.
        expect(reopener.reopenTimeDecisions).not.toHaveBeenCalled();
        expect(await refreshDeltas(stored.id)).toEqual([
          {
            changed_fields: expect.objectContaining({
              name: { old: TITLE, new: 'Quarterly review (moved to Q4)' },
            }),
            changed_by_user_id: null,
          },
        ]);
      });

      it('costs nothing when the source repeats itself: neither row is even rewritten', async () => {
        const [stored] = await service.create(ctx, delivery());
        const before = await row(stored.id);
        jest.clearAllMocks();

        await service.create(ctx, delivery());

        // ctid moves on every UPDATE, even one that writes the same values.
        expect(await row(stored.id)).toEqual(before);
        expect(signalling.send).not.toHaveBeenCalled();
        expect(hbpe.notifyEvents).not.toHaveBeenCalled();
        expect(reopener.reopenTimeDecisions).not.toHaveBeenCalled();
      });

      it('turns a meeting into an all-day event, flag and all', async () => {
        const [stored] = await service.create(ctx, delivery({ is_all_day: false }));

        await service.create(
          ctx,
          delivery({
            start_time: new Date('2026-10-09T00:00:00Z'),
            end_time: new Date('2026-10-10T00:00:00Z'),
            is_all_day: true,
          }),
        );

        expect(await row(stored.id)).toMatchObject({
          start_time: new Date('2026-10-09T00:00:00Z'),
          end_time: new Date('2026-10-10T00:00:00Z'),
          is_all_day: true,
        });
      });

      it('commits the move and its re-open together, or neither', async () => {
        const [stored] = await service.create(ctx, delivery());
        const before = await row(stored.id);
        reopener.reopenTimeDecisions.mockImplementation(async () => {
          throw new Error('pipeline unavailable');
        });

        await expect(
          service.create(ctx, delivery({ start_time: MOVED_START, end_time: MOVED_END })),
        ).rejects.toThrow('pipeline unavailable');

        // Rolled back, base included, so the source's next delivery retries it.
        expect(await row(stored.id)).toEqual(before);
      });
    });

    describe("a user's edit stands", () => {
      it('keeps a meeting the user dragged elsewhere, and follows the source again once the two agree', async () => {
        const [stored] = await service.create(ctx, delivery());
        await service.reschedule(ctx, stored.id, USER_START, USER_END);
        expect(await row(stored.id)).toMatchObject({ external_sync_status: 'pending' });
        jest.clearAllMocks();

        await service.create(ctx, delivery({ start_time: MOVED_START, end_time: MOVED_END }));

        // The user's slot stands; what the source said is still recorded.
        expect(await row(stored.id)).toMatchObject({
          start_time: USER_START,
          end_time: USER_END,
          source_start_time: MOVED_START,
          external_sync_status: 'pending',
        });
        expect(signalling.send).not.toHaveBeenCalled();
        expect(reopener.reopenTimeDecisions).not.toHaveBeenCalled();

        // The organizer comes round to the user's slot: nothing moves, and that
        // agreement becomes the base...
        await service.create(ctx, delivery({ start_time: USER_START, end_time: USER_END }));
        expect(await row(stored.id)).toMatchObject({ start_time: USER_START, source_start_time: USER_START });

        // ...so the organizer's next move is followed.
        await service.create(ctx, delivery({ start_time: MOVED_START, end_time: MOVED_END }));
        expect(await row(stored.id)).toMatchObject({ start_time: MOVED_START, end_time: MOVED_END });
      });

      it("keeps the end a user typed, rather than pair it with the organizer's new start", async () => {
        const [stored] = await service.create(ctx, delivery());
        // The user stretches the meeting to 19:00.
        const stretched = new Date('2026-10-07T19:00:00Z');
        await service.update(ctx, stored.id, { end_time: stretched });

        // The organizer moves it to start at 19:30. Field by field that is
        // 19:30 → 19:00: inverted.
        await service.create(
          ctx,
          delivery({
            start_time: new Date('2026-10-07T19:30:00Z'),
            end_time: new Date('2026-10-07T20:30:00Z'),
          }),
        );

        expect(await row(stored.id)).toMatchObject({ start_time: START, end_time: stretched });
      });

      it('keeps a title the user typed', async () => {
        const [stored] = await service.create(ctx, delivery());
        await service.update(ctx, stored.id, { title: 'Review — bring the numbers' });
        jest.clearAllMocks();

        await service.create(ctx, delivery({ title: 'Quarterly review (rescheduled)' }));

        expect(await row(stored.id)).toMatchObject({
          title: 'Review — bring the numbers',
          source_title: 'Quarterly review (rescheduled)',
        });
        expect(signalling.send).not.toHaveBeenCalled();
      });

      it("reads a row with no base as possibly the user's: it records the base and moves nothing", async () => {
        const [stored] = await service.create(ctx, delivery());
        // A row stored before these bases existed, which the backfill could not
        // clear of a user's edit.
        await dataSource.query(
          `UPDATE ci.events
            SET source_start_time = NULL, source_end_time = NULL, source_recurrence = NULL, source_title = NULL
          WHERE event_id = $1`,
          [stored.id],
        );
        const before = await row(stored.id);
        jest.clearAllMocks();

        await service.create(
          ctx,
          delivery({ start_time: MOVED_START, end_time: MOVED_END, title: 'Renamed' }),
        );

        const after = await row(stored.id);
        expect(after).toMatchObject({
          start_time: START,
          title: TITLE,
          source_start_time: MOVED_START,
          source_end_time: MOVED_END,
          source_title: 'Renamed',
        });
        // Nothing anyone reads moved.
        expect(after.updated_at).toEqual(before.updated_at);
        expect(signalling.send).not.toHaveBeenCalled();
        expect(reopener.reopenTimeDecisions).not.toHaveBeenCalled();
        expect(await refreshDeltas(stored.id)).toEqual([]);
      });
    });

    describe("times that are not the source's word", () => {
      it('never moves a time on an ingest stamp, and lets a real time replace one', async () => {
        // Outlook with no start.dateTime: the transform stamps the sync's wall
        // clock and says so.
        const [stored] = await service.create(
          ctx,
          delivery({
            start_time: START,
            end_time: undefined,
            time_source: 'ingest',
            time_precision: 'unknown',
          }),
        );

        await service.create(
          ctx,
          delivery({
            start_time: MOVED_START,
            end_time: undefined,
            time_source: 'ingest',
            time_precision: 'unknown',
          }),
        );
        expect(await row(stored.id)).toMatchObject({
          start_time: START,
          source_start_time: START,
          time_source: 'ingest',
        });

        await service.create(ctx, delivery({ start_time: USER_START, end_time: USER_END }));
        expect(await row(stored.id)).toMatchObject({
          start_time: USER_START,
          end_time: USER_END,
          // No longer a stamp: the source said when. Unexamined until the clean
          // stage, re-opened, looks.
          time_source: null,
          time_precision: null,
        });
      });

      it('leaves the time and title a delivery filled in when it speaks only for its status', async () => {
        const recurrenceId = '20261005T090000Z';
        const [override] = await service.create(
          ctx,
          delivery({ start_time: MOVED_START, end_time: MOVED_END, title: 'Standup (moved)' }, recurrenceId),
        );

        // Google's cancellation of that occurrence, rebuilt from the series by the
        // transform: the original slot and the series' title, status only asserted.
        await service.create(
          ctx,
          delivery(
            {
              start_time: new Date('2026-10-05T09:00:00Z'),
              end_time: new Date('2026-10-05T09:30:00Z'),
              title: 'Standup',
              status: 'cancelled',
              source_asserts: ['status'],
            },
            recurrenceId,
          ),
        );

        expect(await row(override.id)).toMatchObject({
          status: 'cancelled',
          start_time: MOVED_START,
          title: 'Standup (moved)',
          source_start_time: MOVED_START,
          source_title: 'Standup (moved)',
        });
      });

      it('refuses an inverted pair before anything is written', async () => {
        const [stored] = await service.create(ctx, delivery());
        const before = await row(stored.id);

        await expect(
          service.create(ctx, delivery({ start_time: MOVED_END, end_time: MOVED_START })),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(await row(stored.id)).toEqual(before);
      });
    });

    describe('a row the clean stage repaired', () => {
      const DAY = new Date('2026-12-25T00:00:00Z');
      const NEXT_DAY = new Date('2026-12-26T00:00:00Z');

      /** An all-day event, then what `clean.temporal_repair` does to it for a Pacific user. */
      async function repairedAllDay(label: 'repaired' | 'source'): Promise<string> {
        const [stored] = await service.create(
          ctx,
          delivery({ start_time: DAY, end_time: NEXT_DAY, is_all_day: true }),
        );
        // `source`: a later pass relabelled the row and kept the original pair.
        await dataSource.query(
          `UPDATE ci.events
            SET start_time = '2026-12-25T08:00:00Z', end_time = '2026-12-26T08:00:00Z',
                time_source = $2, time_precision = 'day',
                start_time_original = '2026-12-25T00:00:00Z', end_time_original = '2026-12-26T00:00:00Z'
          WHERE event_id = $1`,
          [stored.id, label],
        );
        jest.clearAllMocks();

        return stored.id;
      }

      it('does not undo the repair when the source repeats itself', async () => {
        const id = await repairedAllDay('repaired');
        const before = await row(id);

        await service.create(ctx, delivery({ start_time: DAY, end_time: NEXT_DAY, is_all_day: true }));

        expect(await row(id)).toEqual(before);
        expect(reopener.reopenTimeDecisions).not.toHaveBeenCalled();
      });

      it.each(['repaired', 'source'] as const)(
        'follows a source move, clears the repair, and re-opens the stage (labelled %s)',
        async (label) => {
          const id = await repairedAllDay(label);
          const moved = new Date('2026-12-28T00:00:00Z');
          const movedEnd = new Date('2026-12-29T00:00:00Z');

          await service.create(ctx, delivery({ start_time: moved, end_time: movedEnd, is_all_day: true }));

          expect(await row(id)).toMatchObject({
            start_time: moved,
            end_time: movedEnd,
            time_source: null,
            time_precision: null,
            start_time_original: null,
            end_time_original: null,
            source_start_time: moved,
          });
          expect(reopener.reopenTimeDecisions).toHaveBeenCalledWith([id], expect.anything());
          expect(hbpe.notifyEvents).toHaveBeenCalledWith(ctx.userId, [
            new Date('2026-12-25T08:00:00Z'),
            moved,
          ]);
        },
      );

      it('keeps a repaired row a person has moved since', async () => {
        const id = await repairedAllDay('repaired');
        await service.reschedule(ctx, id, new Date('2026-12-24T08:00:00Z'), new Date('2026-12-25T08:00:00Z'));
        jest.clearAllMocks();

        await service.create(
          ctx,
          delivery({
            start_time: new Date('2026-12-28T00:00:00Z'),
            end_time: new Date('2026-12-29T00:00:00Z'),
            is_all_day: true,
          }),
        );

        // The person's slot stands, and so does what their move cleared: the
        // stage's record of the time the person replaced is not put back.
        expect(await row(id)).toMatchObject({
          start_time: new Date('2026-12-24T08:00:00Z'),
          time_source: null,
          start_time_original: null,
          source_start_time: new Date('2026-12-28T00:00:00Z'),
        });
        expect(reopener.reopenTimeDecisions).not.toHaveBeenCalled();
      });

      it("keeps the stage's times when the source changes only a repaired series' rule", async () => {
        const yearly = (rule: string): Partial<CreateEventDto> => ({
          start_time: DAY,
          end_time: NEXT_DAY,
          is_all_day: true,
          is_recurring: true,
          metadata: { recurrenceRule: [rule] },
        });
        const [stored] = await service.create(ctx, delivery(yearly('RRULE:FREQ=YEARLY')));
        await dataSource.query(
          `UPDATE ci.events
              SET start_time = '2026-12-25T08:00:00Z', end_time = '2026-12-26T08:00:00Z',
                  time_source = 'repaired', time_precision = 'day',
                  start_time_original = '2026-12-25T00:00:00Z', end_time_original = '2026-12-26T00:00:00Z'
            WHERE event_id = $1`,
          [stored.id],
        );
        jest.clearAllMocks();

        // The family stops celebrating it after three more years.
        await service.create(ctx, delivery(yearly('RRULE:FREQ=YEARLY;COUNT=3')));

        expect(await row(stored.id)).toMatchObject({
          start_time: new Date('2026-12-25T08:00:00Z'),
          time_source: 'repaired',
          start_time_original: DAY,
          metadata: expect.objectContaining({ recurrenceRule: ['RRULE:FREQ=YEARLY;COUNT=3'] }),
          source_recurrence: { rule: ['RRULE:FREQ=YEARLY;COUNT=3'], timeZone: null },
        });
        expect(reopener.reopenTimeDecisions).not.toHaveBeenCalled();
      });
    });

    describe('tombstones and planned blocks', () => {
      it('moves and renames a tombstone quietly, and still re-opens its decisions', async () => {
        const [stored] = await service.create(ctx, delivery());
        await service.remove(ctx, stored.id);
        jest.clearAllMocks();

        await service.create(
          ctx,
          delivery({ start_time: MOVED_START, end_time: MOVED_END, title: 'Renamed' }),
        );

        expect(await row(stored.id)).toMatchObject({
          start_time: MOVED_START,
          title: 'Renamed',
          is_deleted: true,
        });
        expect(signalling.send).not.toHaveBeenCalled();
        expect(hbpe.notifyEvents).not.toHaveBeenCalled();
        expect(await refreshDeltas(stored.id)).toEqual([]);
        // An Undo would bring it back at the new time: the stages must look again.
        expect(reopener.reopenTimeDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
        await expect(service.findById(ctx, stored.id)).resolves.toBeNull();
      });

      it("leaves a planned block's time and title to the planner", async () => {
        const identity = platformIdentity('planning', 'task', uuidv7());
        const block = (start: Date, end: Date, title: string): CreateEventDto => ({
          title,
          event_type: 'planned_block',
          start_time: start,
          end_time: end,
          status: 'planned',
          source_type: 'planning',
          source_system: identity.system,
          source_id: identity.id,
        });

        const [placed] = await service.create(ctx, block(START, END, 'Write the memo'));
        await service.create(ctx, block(MOVED_START, MOVED_END, 'Write the memo, again'));

        expect(await row(placed.id)).toMatchObject({
          start_time: START,
          title: 'Write the memo',
          source_start_time: null,
        });
      });
    });

    describe('recurring series, as findInRange expands them', () => {
      // A weekly Monday standup, from 2026-09-28.
      const SERIES_START = new Date('2026-09-28T09:00:00Z');
      const SERIES_END = new Date('2026-09-28T09:30:00Z');
      const WEEKLY_MONDAY = ['RRULE:FREQ=WEEKLY;BYDAY=MO'];
      const WEEK_FROM = new Date('2026-10-05T00:00:00Z');
      const WEEK_TO = new Date('2026-10-12T00:00:00Z');

      function master(over: Partial<CreateEventDto> = {}): CreateEventDto {
        return delivery({
          title: 'Standup',
          start_time: SERIES_START,
          end_time: SERIES_END,
          is_recurring: true,
          metadata: { recurrenceRule: WEEKLY_MONDAY, recurrenceTimeZone: 'UTC' },
          ...over,
        });
      }

      async function seriesIn(from: Date, to: Date): Promise<Array<{ start: string; synthetic: boolean }>> {
        const events = await service.findInRange(ctx, from, to);

        return events
          .filter((event) => event.title?.startsWith('Standup'))
          .map((event) => ({
            start: event.startTime.toISOString(),
            synthetic: Boolean(event.seriesMasterId),
          }));
      }

      it('follows an override row the organizer moves again, and keeps its slot suppressed', async () => {
        await service.create(ctx, master());
        // "Only this occurrence": the 5 October standup moved to Tuesday 10:00.
        const [override] = await service.create(
          ctx,
          delivery(
            {
              title: 'Standup',
              start_time: new Date('2026-10-06T10:00:00Z'),
              end_time: new Date('2026-10-06T10:30:00Z'),
              is_recurring: true,
            },
            '20261005T090000Z',
          ),
        );
        expect(await seriesIn(WEEK_FROM, WEEK_TO)).toEqual([
          { start: '2026-10-06T10:00:00.000Z', synthetic: false },
        ]);
        jest.clearAllMocks();

        // Moved again, to Wednesday. Same RECURRENCE-ID, so the same row.
        const [moved] = await service.create(
          ctx,
          delivery(
            {
              title: 'Standup',
              start_time: new Date('2026-10-07T11:00:00Z'),
              end_time: new Date('2026-10-07T11:30:00Z'),
              is_recurring: true,
            },
            '20261005T090000Z',
          ),
        );

        expect(moved.id).toBe(override.id);
        expect(await seriesIn(WEEK_FROM, WEEK_TO)).toEqual([
          { start: '2026-10-07T11:00:00.000Z', synthetic: false },
        ]);
        expect(hbpe.notifyEvents).toHaveBeenCalledWith(ctx.userId, [
          new Date('2026-10-06T10:00:00Z'),
          new Date('2026-10-07T11:00:00Z'),
        ]);

        // Out of its week altogether: the 5 October slot stays taken — the key is
        // the RECURRENCE-ID, not the time — so that week is empty, and the next
        // has the real occurrence and the override side by side.
        await service.create(
          ctx,
          delivery(
            {
              title: 'Standup',
              start_time: new Date('2026-10-13T11:00:00Z'),
              end_time: new Date('2026-10-13T11:30:00Z'),
              is_recurring: true,
            },
            '20261005T090000Z',
          ),
        );

        expect(await seriesIn(WEEK_FROM, WEEK_TO)).toEqual([]);
        expect(await seriesIn(WEEK_TO, new Date('2026-10-19T00:00:00Z'))).toEqual([
          { start: '2026-10-12T09:00:00.000Z', synthetic: true },
          { start: '2026-10-13T11:00:00.000Z', synthetic: false },
        ]);
      });

      it('moves a whole series: its DTSTART and its BYDAY together', async () => {
        await service.create(ctx, master());
        expect(await seriesIn(WEEK_FROM, WEEK_TO)).toEqual([
          { start: '2026-10-05T09:00:00.000Z', synthetic: true },
        ]);

        // Every standup moves to Tuesday at 10:00.
        await service.create(
          ctx,
          master({
            start_time: new Date('2026-09-29T10:00:00Z'),
            end_time: new Date('2026-09-29T10:30:00Z'),
            metadata: { recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=TU'], recurrenceTimeZone: 'UTC' },
          }),
        );

        expect(await seriesIn(WEEK_FROM, WEEK_TO)).toEqual([
          { start: '2026-10-06T10:00:00.000Z', synthetic: true },
        ]);
      });

      it('ends a series its organizer cut short, moving no time', async () => {
        const [stored] = await service.create(ctx, master());
        expect(await seriesIn(WEEK_TO, new Date('2026-10-19T00:00:00Z'))).toHaveLength(1);
        jest.clearAllMocks();

        // "This and following" ends the old series with an UNTIL; the new series
        // arrives as an event of its own.
        await service.create(
          ctx,
          master({
            metadata: {
              recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261006T000000Z'],
              recurrenceTimeZone: 'UTC',
            },
          }),
        );

        expect(await seriesIn(WEEK_FROM, WEEK_TO)).toEqual([
          { start: '2026-10-05T09:00:00.000Z', synthetic: true },
        ]);
        expect(await seriesIn(WEEK_TO, new Date('2026-10-19T00:00:00Z'))).toEqual([]);
        expect(await row(stored.id)).toMatchObject({ start_time: SERIES_START, is_recurring: true });
        expect(signalling.send).toHaveBeenCalledWith(EventUpdatedEvent, { eventId: stored.id });
        // The rule changed, the time did not: nothing decided on the time is stale.
        expect(reopener.reopenTimeDecisions).not.toHaveBeenCalled();
      });
    });

    describe('decided under the lock', () => {
      it("keeps a user's move that commits while the sync waits on the row lock", async () => {
        const [stored] = await service.create(ctx, delivery());

        await withOpenTransaction(
          async (query) => {
            // The user drags the meeting, and has not committed yet.
            await query(
              `UPDATE ci.events SET start_time = $2, end_time = $3, last_moved_at = now() WHERE event_id = $1`,
              [stored.id, USER_START, USER_END],
            );
          },
          async (pid) => {
            // Meanwhile the organizer moves it, and the sync delivers that.
            const sync = service.create(ctx, delivery({ start_time: MOVED_START, end_time: MOVED_END }));
            // Rendezvous on the lock itself, not on timing: the sync must be
            // QUEUED behind the user before the user commits.
            await waitFor(() => someoneWaitsOn(pid), 'the sync to queue behind the user');

            return { sync };
          },
        ).then(({ sync }) => sync);

        expect(await row(stored.id)).toMatchObject({
          start_time: USER_START,
          end_time: USER_END,
          source_start_time: MOVED_START,
        });
      });

      it("keeps a user's rename that commits while the sync waits on the event row", async () => {
        const [stored] = await service.create(ctx, delivery());

        await withOpenTransaction(
          async (query) => {
            // What `update` does for a title-only patch: the event row first.
            await query('UPDATE ci.events SET updated_at = now() WHERE event_id = $1', [stored.id]);
            await query(`UPDATE ci.entities SET name = 'Mine' WHERE entity_id = $1`, [stored.id]);
          },
          async (pid) => {
            const sync = service.create(ctx, delivery({ title: 'Renamed' }));
            await waitFor(() => someoneWaitsOn(pid), 'the sync to queue behind the user');

            return { sync };
          },
        ).then(({ sync }) => sync);

        expect(await row(stored.id)).toMatchObject({ title: 'Mine', source_title: 'Renamed' });
      });

      it('keeps a rename committed by a writer that locks only the base row', async () => {
        const [stored] = await service.create(ctx, delivery());

        await withOpenTransaction(
          async (query) => {
            await query(`UPDATE ci.entities SET name = 'Mine' WHERE entity_id = $1`, [stored.id]);
          },
          async (pid) => {
            // The sync holds the event row by now and must wait for the base row
            // before it reads the title.
            const sync = service.create(ctx, delivery({ title: 'Renamed' }));
            await waitFor(() => someoneWaitsOn(pid), 'the sync to queue behind the rename');

            return { sync };
          },
        ).then(({ sync }) => sync);

        expect(await row(stored.id)).toMatchObject({ title: 'Mine', source_title: 'Renamed' });
      });
    });

    describe('one lock order: the event row before its base row', () => {
      /**
       * Hold the event row, start `write`, and once it waits on that row, check
       * that it holds no lock on the base row: the order a sync's refresh takes
       * them, so neither can hold one while waiting for the other.
       */
      async function assertEventRowFirst(id: string, write: () => Promise<unknown>): Promise<void> {
        let pending: Promise<unknown> | undefined;

        await withOpenTransaction(
          async (query) => {
            await query('SELECT 1 FROM ci.events WHERE event_id = $1 FOR UPDATE', [id]);
          },
          async (pid) => {
            pending = write();
            await waitFor(() => someoneWaitsOn(pid), 'the write to queue on the event row');

            const probe = dataSource.createQueryRunner();
            await probe.connect();
            await probe.startTransaction();

            try {
              await expect(
                probe.query('SELECT 1 FROM ci.entities WHERE entity_id = $1 FOR UPDATE NOWAIT', [id]),
              ).resolves.toHaveLength(1);
            } finally {
              await probe.rollbackTransaction();
              await probe.release();
            }
          },
        );

        await pending;
      }

      it('update, for a rename alone', async () => {
        const [stored] = await service.create(ctx, delivery());

        await assertEventRowFirst(stored.id, () => service.update(ctx, stored.id, { title: 'Mine' }));

        expect(await row(stored.id)).toMatchObject({ title: 'Mine' });
      });

      it('remove', async () => {
        const [stored] = await service.create(ctx, delivery());

        await assertEventRowFirst(stored.id, () => service.remove(ctx, stored.id));

        expect(await row(stored.id)).toMatchObject({ is_deleted: true });
      });
    });
  },
);
