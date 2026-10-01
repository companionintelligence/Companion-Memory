import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import {
  BaseEntity,
  CalendarEventService,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
  type Event,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import {
  databaseAvailability,
  dataSourceConnection,
} from '../../../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../../../__tests__/support/schemaLock';
import { GoogleCalendarTransformService } from '../TransformGoogleCalendar';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CANCELLATION AT GOOGLE REACHES THE CALENDAR. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Google connection re-delivers every change through its sync token, and
 * asks for `showDeleted=true`, so a meeting cancelled after its first sync DOES
 * come back to the transform. Two things then lost it:
 *
 *  1. A full payload (the organizer's own calendar keeps the details) reached
 *     `CalendarEventService.createOne`, which found the row by its identity and
 *     handed it back verbatim — `confirmed` for good.
 *  2. A cancelled OCCURRENCE of a series arrives as Google's minimal stub —
 *     `id`, `recurringEventId`, `originalStartTime`, `status` and nothing else,
 *     no `start`, usually no `iCalUID`. `transformToEventDto` threw "has no start
 *     time" and the per-event catch swallowed it. Nothing was written, so the
 *     read-time expander kept synthesizing that occurrence from the master's
 *     RRULE: on the grid, in the planner's occupancy, in free/busy.
 *
 * Everything here runs the REAL transform into the REAL CalendarEventService on
 * a migrated database, and reads the result back through `findInRange` — the
 * choke point the schedule grid and PlannedBlockService both read. Geocoding and
 * participant promotion are stubbed: neither is on the path under test.
 *
 * Opt-in like the sibling integration specs: set MEMORY_TEST_DATABASE_URL to a
 * migrated database of your own.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[etl/TransformGoogleCalendar.cancellation] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const PACIFIC = 'America/Los_Angeles';

/** A Google event id. Real ones are base32hex; hex digits are a subset. */
function googleId(): string {
  return uuidv7().replace(/-/g, '');
}

/** What Google sends for a weekly standup it owns: Mondays 09:00 Pacific, from 7 Sep 2026. */
function standupMaster(id: string, over: Record<string, unknown> = {}) {
  return {
    kind: 'calendar#event',
    id,
    iCalUID: `${id}@google.com`,
    status: 'confirmed',
    summary: 'Weekly standup',
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    created: '2026-09-01T10:00:00.000Z',
    updated: '2026-09-01T10:00:00.000Z',
    start: { dateTime: '2026-09-07T09:00:00-07:00', timeZone: PACIFIC },
    end: { dateTime: '2026-09-07T09:30:00-07:00', timeZone: PACIFIC },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
    ...over,
  };
}

/**
 * Google's cancelled exception, exactly as `events.list` returns it: only these
 * fields are guaranteed. No `start`, no `summary`, no `iCalUID`.
 */
function cancelledOccurrenceStub(
  masterId: string,
  originalStartTime: Record<string, string>,
  instant: string,
) {
  return {
    kind: 'calendar#event',
    etag: '"3500000000000000"',
    id: `${masterId}_${instant}`,
    status: 'cancelled',
    recurringEventId: masterId,
    originalStartTime,
  };
}

describeWithDb(
  `GoogleCalendarTransformService — cancellations after the first sync (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let events: CalendarEventService;
    let transform: GoogleCalendarTransformService;
    let ctx: UserServiceContext;
    let connectionId: string;

    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const promote = { processParticipants: jest.fn(async () => []) };
    const geocode = {
      geocode: jest.fn(async () => ({ status: 'ZERO_RESULTS', point: null, confidence: null })),
    };
    const noopSignalling = { send: async () => undefined };
    const noopLogger = {
      setContext: () => undefined,
      log: () => undefined,
      debug: () => undefined,
      warn: () => undefined,
    } as unknown as LoggerService;

    /** One sync page through the real transform, as SyncOrchestrator hands it over. */
    async function sync(items: unknown[]): Promise<void> {
      await transform.transformGoogleCalendar({
        connection: { id: connectionId } as never,
        syncJob: { id: uuidv7(), userId: ctx.userId, data: { items } } as never,
      });
    }

    /** The calendar's own read for one UTC day — grid, planner occupancy and free/busy all go through it. */
    function day(isoDate: string): Promise<Event[]> {
      const from = new Date(`${isoDate}T00:00:00Z`);

      return events.findInRange(ctx, from, new Date(from.getTime() + 86_400_000));
    }

    async function rowBySourceId(sourceId: string): Promise<Record<string, unknown> | undefined> {
      const [row] = await dataSource.query(
        `SELECT e.status, e.is_deleted, e.start_time, e.end_time, e.is_all_day, e.source_type, n.name AS title
         FROM ci.events e
         JOIN ci.entities n ON n.entity_id = e.event_id
        WHERE e.user_id = $1 AND e.source_system = 'calendar' AND e.source_id = $2`,
        [ctx.userId, sourceId],
      );

      return row;
    }

    function errorsLogged(): unknown[] {
      return logger.error.mock.calls.map(([message, meta]) => ({ message, meta }));
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
      schemaLock = await acquireSchemaWriteLock(dataSource, 'etl/TransformGoogleCalendar.cancellation');

      events = new CalendarEventService(
        dataSource.getRepository(EventEntity),
        dataSource.getRepository(EventBaseEntity),
        noopSignalling as never,
        dataSource,
        new GraphDeltaWriter(dataSource, noopLogger),
      );
      transform = new GoogleCalendarTransformService(
        events,
        {} as never, // ConnectionService — the transform never calls it
        promote as never,
        geocode as never,
        logger as unknown as LoggerService,
      );
    });

    beforeEach(async () => {
      jest.clearAllMocks();
      // A user per test: findInRange and its zone cache are per user, so no test
      // can see another's series.
      ctx = { userId: uuidv7() } as UserServiceContext;
      connectionId = uuidv7();
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Calendar cancellation fixture', $2, 'x', true, $3)`,
        [ctx.userId, `calendar.${ctx.userId}@example.test`, PACIFIC],
      );
    });

    afterEach(async () => {
      await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    describe('a full payload whose status changed', () => {
      function lunch(id: string, status: string) {
        return {
          kind: 'calendar#event',
          id,
          iCalUID: `${id}@google.com`,
          status,
          summary: 'Lunch with Ada',
          updated: status === 'confirmed' ? '2026-09-01T10:00:00.000Z' : '2026-09-20T08:00:00.000Z',
          start: { dateTime: '2026-09-23T12:00:00-07:00', timeZone: PACIFIC },
          end: { dateTime: '2026-09-23T13:00:00-07:00', timeZone: PACIFIC },
        };
      }

      it('cancels a meeting that was confirmed at its first sync, and takes it off the calendar', async () => {
        const id = googleId();

        await sync([lunch(id, 'confirmed')]);
        expect((await day('2026-09-23')).map((event) => event.title)).toEqual(['Lunch with Ada']);

        await sync([lunch(id, 'cancelled')]);

        expect(await rowBySourceId(`${id}@google.com`)).toMatchObject({
          status: 'cancelled',
          is_deleted: false,
        });
        expect(await day('2026-09-23')).toEqual([]);
      });

      it('brings it back when Google restores it', async () => {
        const id = googleId();

        await sync([lunch(id, 'confirmed')]);
        await sync([lunch(id, 'cancelled')]);
        await sync([lunch(id, 'confirmed')]);

        expect(await rowBySourceId(`${id}@google.com`)).toMatchObject({ status: 'confirmed' });
        expect((await day('2026-09-23')).map((event) => event.title)).toEqual(['Lunch with Ada']);
      });

      it("never undoes the user's own deletion, but an Undo brings back what Google says now", async () => {
        const id = googleId();

        await sync([lunch(id, 'confirmed')]);
        const [stored] = await day('2026-09-23');
        await events.remove(ctx, stored.id);

        await sync([lunch(id, 'cancelled')]);

        expect(await rowBySourceId(`${id}@google.com`)).toMatchObject({
          is_deleted: true,
          status: 'cancelled',
        });

        // The delete toast's Undo. Restoring must not resurrect a meeting that
        // was cancelled while it sat in the trash.
        await events.restore(ctx, stored.id);
        expect(await day('2026-09-23')).toEqual([]);
      });

      it('keeps a status the user set, whatever Google says afterwards', async () => {
        const id = googleId();

        await sync([lunch(id, 'confirmed')]);
        const [stored] = await day('2026-09-23');
        await events.update(ctx, stored.id, { status: 'tentative' });

        await sync([lunch(id, 'cancelled')]);

        expect(await rowBySourceId(`${id}@google.com`)).toMatchObject({ status: 'tentative' });
      });

      it('cancels a meeting whose deletion arrives as an id-only stub', async () => {
        const id = googleId();

        await sync([lunch(id, 'confirmed')]);
        // "Deleted events are only guaranteed to have the id field populated."
        await sync([{ kind: 'calendar#event', etag: '"3500000000000001"', id, status: 'cancelled' }]);

        expect(await rowBySourceId(`${id}@google.com`)).toMatchObject({ status: 'cancelled' });
        expect(await day('2026-09-23')).toEqual([]);
        expect(errorsLogged()).toEqual([]);
      });
    });

    describe("Google's minimal stub for one cancelled occurrence", () => {
      const SEP_21 = { dateTime: '2026-09-21T09:00:00-07:00', timeZone: PACIFIC };
      const SEP_28 = { dateTime: '2026-09-28T09:00:00-07:00', timeZone: PACIFIC };

      it('writes the cancelled override the expander suppresses on, and the occurrence leaves the calendar', async () => {
        const masterId = googleId();

        await sync([standupMaster(masterId)]);
        // Sanity: the series expands, so the occurrence is there to lose.
        expect((await day('2026-09-21')).map((event) => event.startTime.toISOString())).toEqual([
          '2026-09-21T16:00:00.000Z',
        ]);

        await sync([cancelledOccurrenceStub(masterId, SEP_21, '20260921T160000Z')]);

        expect(await day('2026-09-21')).toEqual([]);
        // Only that one: the next Monday still has its standup.
        expect((await day('2026-09-28')).map((event) => event.title)).toEqual(['Weekly standup']);

        // The row the expander reads, under the key it computes — `<uid>#<instant>`
        // — carrying what the stub could not: the master's title and slot.
        expect(await rowBySourceId(`${masterId}@google.com#20260921T160000Z`)).toMatchObject({
          status: 'cancelled',
          is_deleted: false,
          title: 'Weekly standup',
          start_time: new Date('2026-09-21T16:00:00Z'),
          end_time: new Date('2026-09-21T16:30:00Z'),
          is_all_day: false,
        });
        expect(errorsLogged()).toEqual([]);
      });

      it('cancels the override row that already exists for a moved occurrence', async () => {
        const masterId = googleId();
        const moved = {
          kind: 'calendar#event',
          id: `${masterId}_20260928T160000Z`,
          iCalUID: `${masterId}@google.com`,
          status: 'confirmed',
          summary: 'Weekly standup (moved)',
          recurringEventId: masterId,
          originalStartTime: SEP_28,
          start: { dateTime: '2026-09-28T11:00:00-07:00', timeZone: PACIFIC },
          end: { dateTime: '2026-09-28T11:30:00-07:00', timeZone: PACIFIC },
        };

        await sync([standupMaster(masterId), moved]);
        expect((await day('2026-09-28')).map((event) => event.startTime.toISOString())).toEqual([
          '2026-09-28T18:00:00.000Z',
        ]);

        await sync([cancelledOccurrenceStub(masterId, SEP_28, '20260928T160000Z')]);

        expect(await rowBySourceId(`${masterId}@google.com#20260928T160000Z`)).toMatchObject({
          status: 'cancelled',
          title: 'Weekly standup (moved)',
          start_time: new Date('2026-09-28T18:00:00Z'),
        });
        expect(await day('2026-09-28')).toEqual([]);
      });

      it('resolves a series the Takeout .ics import stored first, by the Google-native UID', async () => {
        const masterId = googleId();

        // What the importer pushes for the same series: the UID, the rule, no
        // Google event id anywhere on the row.
        await events.create(ctx, {
          title: 'Weekly standup',
          event_type: 'calendar_event',
          start_time: new Date('2026-09-07T16:00:00Z'),
          end_time: new Date('2026-09-07T16:30:00Z'),
          is_recurring: true,
          source_type: 'ci-import-tools',
          source_system: 'calendar' as never,
          source_id: `${masterId}@google.com` as never,
          metadata: { recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO'], recurrenceTimeZone: PACIFIC },
        });

        await sync([cancelledOccurrenceStub(masterId, SEP_21, '20260921T160000Z')]);

        expect(await day('2026-09-21')).toEqual([]);
        expect((await day('2026-09-28')).map((event) => event.title)).toEqual(['Weekly standup']);
      });

      it('resolves the series from the same page on a first sync, whatever order the page is in', async () => {
        const masterId = googleId();

        await sync([cancelledOccurrenceStub(masterId, SEP_21, '20260921T160000Z'), standupMaster(masterId)]);

        expect(await day('2026-09-21')).toEqual([]);
        expect(await rowBySourceId(`${masterId}@google.com#20260921T160000Z`)).toMatchObject({
          status: 'cancelled',
          title: 'Weekly standup',
        });
      });

      it('writes nothing, and fails nothing, for a series it has never seen', async () => {
        const masterId = googleId();

        await sync([cancelledOccurrenceStub(masterId, SEP_21, '20260921T160000Z')]);

        const [{ count }] = await dataSource.query(
          'SELECT count(*)::int AS count FROM ci.events WHERE user_id = $1',
          [ctx.userId],
        );
        expect(count).toBe(0);
        expect(errorsLogged()).toEqual([]);
      });

      it('suppresses a cancelled day of an ALL-DAY series, keyed the way both pipelines key it', async () => {
        const masterId = googleId();

        await sync([
          standupMaster(masterId, {
            summary: 'Office day',
            start: { date: '2026-09-07' },
            end: { date: '2026-09-08' },
          }),
        ]);
        expect((await day('2026-09-21')).map((event) => event.title)).toEqual(['Office day']);

        await sync([cancelledOccurrenceStub(masterId, { date: '2026-09-21' }, '20260921')]);

        // `uid#YYYYMMDD` — a DATE-valued RECURRENCE-ID, what the transform and
        // the .ics importer both write for an all-day override.
        expect(await rowBySourceId(`${masterId}@google.com#20260921`)).toMatchObject({
          status: 'cancelled',
          is_all_day: true,
        });
        expect(await day('2026-09-21')).toEqual([]);
        expect((await day('2026-09-28')).map((event) => event.title)).toEqual(['Office day']);
      });

      it('puts the occurrence back when Google restores it, exactly once', async () => {
        const masterId = googleId();

        await sync([standupMaster(masterId)]);
        await sync([cancelledOccurrenceStub(masterId, SEP_21, '20260921T160000Z')]);

        // Undo in Google: the instance comes back as a full, confirmed exception.
        await sync([
          {
            kind: 'calendar#event',
            id: `${masterId}_20260921T160000Z`,
            iCalUID: `${masterId}@google.com`,
            status: 'confirmed',
            summary: 'Weekly standup',
            recurringEventId: masterId,
            originalStartTime: SEP_21,
            start: SEP_21,
            end: { dateTime: '2026-09-21T09:30:00-07:00', timeZone: PACIFIC },
          },
        ]);

        // The override row now IS that occurrence, so the expander still stays
        // out of the way: one standup, not two.
        expect((await day('2026-09-21')).map((event) => event.startTime.toISOString())).toEqual([
          '2026-09-21T16:00:00.000Z',
        ]);
      });
    });
  },
);
