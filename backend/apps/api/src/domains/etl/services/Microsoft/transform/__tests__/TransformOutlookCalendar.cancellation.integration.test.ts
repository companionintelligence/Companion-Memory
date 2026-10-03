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
import { OutlookCalendarTransformService } from '../TransformOutlookCalendar';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CANCELLATION IN OUTLOOK REACHES THE CALENDAR. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Graph tells a calendar's delta round about a cancellation in one of two ways,
 * depending on whose calendar it is:
 *
 *  1. An ATTENDEE's copy stays on their calendar, as the event itself with
 *     `isCancelled: true` (and "Canceled: " in front of its subject). For one
 *     occurrence of a series it is that occurrence, now an exception: the same
 *     `seriesMasterId` and `originalStart`. The transform dropped every such
 *     payload ("Skipping cancelled event"), so a meeting confirmed at its first
 *     sync stayed confirmed: on the grid, in the planner's occupancy, in Known
 *     places.
 *  2. The ORGANIZER's copy (and anything deleted outright) leaves the calendar,
 *     and the round reports a tombstone: the Graph `id` and `@removed`, nothing
 *     else. The transform dropped those too, and could not have done otherwise:
 *     no stored row carried the Graph id, and a tombstone carries nothing else.
 *
 * Graph also reports `@removed` for any event OUTSIDE the round's date range
 * that was added, edited or deleted ("Filter the events under @removed for the
 * date range that your scenario requires" — event: delta, v1.0). So a tombstone
 * is a deletion only for a stored event inside that range; SyncOutlookCalendar
 * records the range beside each calendar's link and hands it over with the
 * calendar's events.
 *
 * Everything here runs the REAL transform into the REAL CalendarEventService on
 * a migrated database, and reads results back through `findInRange` — the read
 * the schedule grid and PlannedBlockService share. Participant promotion is
 * stubbed: it is not on the path under test, but WHETHER it runs is.
 *
 * Fixture times are spelled as Graph spells them: `start.dateTime` has no offset
 * and `start.timeZone` names its zone (UTC here: nothing asks for another). The
 * transform reads the wall clock in that zone, so they mean the same instant on
 * every machine. They carried a `Z` while it handed the string to `new Date`,
 * which reads an offset-less one in the zone of the process, and a `Z` was the
 * only way to keep this spec from depending on where it ran. See
 * graphDateTime.ts and TransformOutlookCalendar.graphTime.test.ts.
 *
 * Opt-in like the sibling integration specs: set MEMORY_TEST_DATABASE_URL to a
 * migrated database of your own.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[etl/TransformOutlookCalendar.cancellation] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const PACIFIC = 'America/Los_Angeles';
const DAY_MS = 86_400_000;

/** The date range a calendar's delta round was opened with, as SyncOutlookCalendar records it. */
const WINDOW = { startDateTime: '2026-09-01T00:00:00.000Z', endDateTime: '2029-09-01T00:00:00.000Z' };

const WORK_CALENDAR = 'AAMkADwork-calendar=';
const FAMILY_CALENDAR = 'AAMkADfamily-calendar=';

/** A Graph event id: opaque base64. Random so no test can see another's. */
function graphId(): string {
  return `AAMkAD${uuidv7().replace(/-/g, '')}AAA=`;
}

/** The UID Exchange mints for a meeting, which Graph spells `iCalUId`. */
function exchangeUid(): string {
  return `040000008200E00074C5B7101A82E00800000000${uuidv7().replace(/-/g, '').toUpperCase()}`;
}

/** Graph's `dateTimeTimeZone` for an instant, to the second: no offset, seven fractional digits, `UTC`. */
function utc(instant: string | number): { dateTime: string; timeZone: string } {
  return { dateTime: new Date(instant).toISOString().replace(/\.\d{3}Z$/, '.0000000'), timeZone: 'UTC' };
}

/** A tombstone exactly as calendarView/delta sends it: the type, the id and the annotation. */
function removed(id: string) {
  return { '@odata.type': '#microsoft.graph.event', id, '@removed': { reason: 'deleted' } };
}

/** What Graph sends for a meeting the user was invited to: lunch on Wednesday 23 September. */
function lunch(id: string, uid: string, over: Record<string, unknown> = {}) {
  return {
    '@odata.type': '#microsoft.graph.event',
    '@odata.etag': 'W/"DwAAABYAAABhd7AT0j5qQ5L3v1bmsWnPAAAJxkD7"',
    id,
    iCalUId: uid,
    type: 'singleInstance',
    subject: 'Lunch with Ada',
    bodyPreview: '',
    isCancelled: false,
    isAllDay: false,
    isOrganizer: false,
    start: utc('2026-09-23T19:00:00Z'),
    end: utc('2026-09-23T20:00:00Z'),
    organizer: { emailAddress: { name: 'Ada Lovelace', address: 'ada@example.test' } },
    attendees: [
      {
        type: 'required',
        status: { response: 'accepted', time: '2026-09-01T10:00:00Z' },
        emailAddress: { name: 'Ada Lovelace', address: 'ada@example.test' },
      },
    ],
    webLink: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(id)}&exvsurl=1&path=/calendar/item`,
    ...over,
  };
}

/** What the attendee's calendar shows once the organizer cancels it. */
function cancelled(event: ReturnType<typeof lunch>) {
  return { ...event, isCancelled: true, subject: `Canceled: ${event.subject}` };
}

/**
 * One occurrence of a weekly standup, Mondays 09:00 Pacific, as calendarView
 * expands it: its own id and iCalUId, its series in `seriesMasterId`, its slot
 * in `originalStart`.
 */
function standup(masterId: string, uid: string, monday: string, over: Record<string, unknown> = {}) {
  const start = `${monday}T16:00:00Z`;

  return lunch(`${masterId}-${monday}`, `${uid}-${monday}`, {
    type: 'occurrence',
    subject: 'Weekly standup',
    seriesMasterId: masterId,
    originalStart: start,
    originalStartTimeZone: 'Pacific Standard Time',
    start: utc(start),
    end: utc(`${monday}T16:30:00Z`),
    ...over,
  });
}

describeWithDb(
  `OutlookCalendarTransformService — cancellations after the first sync (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let events: CalendarEventService;
    let transform: OutlookCalendarTransformService;
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
    const signalling = { send: jest.fn(async () => undefined) };
    const noopLogger = {
      setContext: () => undefined,
      log: () => undefined,
      debug: () => undefined,
      warn: () => undefined,
    } as unknown as LoggerService;

    /** One sync job through the real transform, shaped as SyncOutlookCalendar writes it. */
    async function job(calendars: Array<Record<string, unknown>>): Promise<void> {
      await transform.transformOutlookCalendar({
        connection: { id: connectionId } as never,
        syncJob: { id: uuidv7(), userId: ctx.userId, data: { calendars } } as never,
      });
    }

    /** An incremental run: the calendar's delta round, with the date range it covers. */
    function delta(
      items: unknown[],
      { calendarId = WORK_CALENDAR, window = WINDOW as typeof WINDOW | null } = {},
    ): Promise<void> {
      return job([{ id: calendarId, events: items, ...(window ? { deltaWindow: window } : {}) }]);
    }

    /** The historical walk (`/events`): every event the calendar holds, with no date range. */
    function historical(items: unknown[]): Promise<void> {
      return job([{ id: WORK_CALENDAR, events: items }]);
    }

    /** The calendar's own read for one UTC day — grid, planner occupancy and free/busy all go through it. */
    function day(isoDate: string): Promise<Event[]> {
      const from = new Date(`${isoDate}T00:00:00Z`);

      return events.findInRange(ctx, from, new Date(from.getTime() + DAY_MS));
    }

    async function titlesOn(isoDate: string): Promise<string[]> {
      return (await day(isoDate)).map((event) => event.title ?? '');
    }

    /** The stored row for a UID (with its RECURRENCE-ID for an occurrence), read past every filter. */
    async function row(uid: string, recurrenceId?: string): Promise<Record<string, unknown> | undefined> {
      const [found] = await dataSource.query(
        `SELECT e.event_id AS id, e.status, e.is_deleted, e.start_time,
                e.metadata->>'rawEventId' AS raw_event_id, n.name AS title
           FROM ci.events e
           JOIN ci.entities n ON n.entity_id = e.event_id
          WHERE e.user_id = $1 AND e.source_system = 'calendar' AND e.source_id = $2`,
        [ctx.userId, recurrenceId ? `${uid}#${recurrenceId}` : uid],
      );

      return found;
    }

    /** Make a row look as the transform wrote it before it kept the Graph id. */
    async function forgetGraphIds(): Promise<void> {
      await dataSource.query(`UPDATE ci.events SET metadata = metadata - 'rawEventId' WHERE user_id = $1`, [
        ctx.userId,
      ]);
    }

    async function eventCount(): Promise<number> {
      const [{ count }] = await dataSource.query(
        'SELECT count(*)::int AS count FROM ci.events WHERE user_id = $1',
        [ctx.userId],
      );

      return count;
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
      schemaLock = await acquireSchemaWriteLock(dataSource, 'etl/TransformOutlookCalendar.cancellation');

      // A status that calls an event off settles what the pipeline decided about
      // it; this suite is about the transform, so PipelineModule's binding is a
      // no-op here (CalendarEventService.pipelineDecisions covers what asks).
      const pipelineReopeners = {
        reopenTimeDecisions: async (): Promise<number> => 0,
        reopenStatusDecisions: async (): Promise<number> => 0,
      };

      events = new CalendarEventService(
        dataSource.getRepository(EventEntity),
        dataSource.getRepository(EventBaseEntity),
        signalling as never,
        dataSource,
        new GraphDeltaWriter(dataSource, noopLogger),
        undefined,
        { get: () => pipelineReopeners } as never,
      );
      transform = new OutlookCalendarTransformService(
        events,
        {} as never, // ConnectionService — the transform never calls it
        promote as never,
        logger as unknown as LoggerService,
      );
    });

    beforeEach(async () => {
      jest.clearAllMocks();
      // A user per test, so no test can see another's rows.
      ctx = { userId: uuidv7() } as UserServiceContext;
      connectionId = uuidv7();
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
         VALUES ($1, 'Outlook cancellation fixture', $2, 'x', true, $3)`,
        [ctx.userId, `outlook.${ctx.userId}@example.test`, PACIFIC],
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

    describe('the event itself, delivered with isCancelled (an attendee’s copy)', () => {
      it('cancels a meeting confirmed at its first sync, and takes it off the calendar', async () => {
        const meeting = lunch(graphId(), exchangeUid());

        await delta([meeting]);
        expect(await titlesOn('2026-09-23')).toEqual(['Lunch with Ada']);
        expect(promote.processParticipants).toHaveBeenCalled();
        promote.processParticipants.mockClear();

        await delta([cancelled(meeting)]);

        expect(await row(meeting.iCalUId)).toMatchObject({
          status: 'cancelled',
          is_deleted: false,
          // The row keeps the name it was stored under, not "Canceled: …".
          title: 'Lunch with Ada',
        });
        expect(await day('2026-09-23')).toEqual([]);
        // Nobody was met at a meeting that is not happening.
        expect(promote.processParticipants).not.toHaveBeenCalled();
        expect(errorsLogged()).toEqual([]);
      });

      it('stores a meeting first seen already cancelled, off the calendar, and meets nobody at it', async () => {
        const meeting = cancelled(lunch(graphId(), exchangeUid()));

        await delta([meeting]);

        expect(await row(meeting.iCalUId)).toMatchObject({ status: 'cancelled', is_deleted: false });
        expect(await day('2026-09-23')).toEqual([]);
        expect(promote.processParticipants).not.toHaveBeenCalled();
      });

      it('cancels the one occurrence of a series that was cancelled, and only that one', async () => {
        const masterId = graphId();
        const uid = exchangeUid();

        await delta([standup(masterId, uid, '2026-09-21'), standup(masterId, uid, '2026-09-28')]);
        expect(await titlesOn('2026-09-21')).toEqual(['Weekly standup']);

        // The occurrence becomes an exception: same series, same slot, cancelled.
        await delta([
          standup(masterId, uid, '2026-09-21', {
            type: 'exception',
            isCancelled: true,
            subject: 'Canceled: Weekly standup',
          }),
        ]);

        expect(await row(`${uid}-2026-09-21`, '20260921T160000Z')).toMatchObject({ status: 'cancelled' });
        expect(await day('2026-09-21')).toEqual([]);
        expect(await titlesOn('2026-09-28')).toEqual(['Weekly standup']);
      });

      it("never undoes the user's own deletion, but an Undo brings back what Outlook says now", async () => {
        const meeting = lunch(graphId(), exchangeUid());

        await delta([meeting]);
        const [stored] = await day('2026-09-23');
        await events.remove(ctx, stored.id);

        await delta([cancelled(meeting)]);

        expect(await row(meeting.iCalUId)).toMatchObject({ is_deleted: true, status: 'cancelled' });

        // The delete toast's Undo must not resurrect a meeting cancelled meanwhile.
        await events.restore(ctx, stored.id);
        expect(await day('2026-09-23')).toEqual([]);
      });

      it('keeps a status the user set, and cancels the meeting beside it they did not touch', async () => {
        const kept = lunch(graphId(), exchangeUid());
        const untouched = lunch(graphId(), exchangeUid(), { subject: 'Dentist' });

        await delta([kept, untouched]);
        await events.update(ctx, (await row(kept.iCalUId))!.id as string, { status: 'tentative' });

        await delta([cancelled(kept), cancelled(untouched)]);

        expect(await row(kept.iCalUId)).toMatchObject({ status: 'tentative' });
        expect(await row(untouched.iCalUId)).toMatchObject({ status: 'cancelled' });
      });
    });

    describe('a tombstone, delivered as @removed (the organizer’s copy, or a deletion)', () => {
      it('cancels the stored event a tombstone names — a status, never the tombstone flag', async () => {
        const meeting = lunch(graphId(), exchangeUid(), { isOrganizer: true });

        await delta([meeting]);
        await delta([removed(meeting.id)]);

        expect(await row(meeting.iCalUId)).toMatchObject({ status: 'cancelled', is_deleted: false });
        expect(await day('2026-09-23')).toEqual([]);
        expect(errorsLogged()).toEqual([]);
      });

      it('cancels the one occurrence the organizer deleted, and only that one', async () => {
        const masterId = graphId();
        const uid = exchangeUid();
        const sep21 = standup(masterId, uid, '2026-09-21', { isOrganizer: true });

        await delta([sep21, standup(masterId, uid, '2026-09-28', { isOrganizer: true })]);
        await delta([removed(sep21.id)]);

        expect(await row(`${uid}-2026-09-21`, '20260921T160000Z')).toMatchObject({ status: 'cancelled' });
        expect(await day('2026-09-21')).toEqual([]);
        expect(await titlesOn('2026-09-28')).toEqual(['Weekly standup']);
      });

      it("acts only inside the round's date range: outside it, Graph reports edits as removals too", async () => {
        // August: before the round's range. Only the historical walk ever stores it.
        const past = lunch(graphId(), exchangeUid(), {
          subject: 'Kickoff',
          start: utc('2026-08-10T17:00:00Z'),
          end: utc('2026-08-10T18:00:00Z'),
        });
        const inside = lunch(graphId(), exchangeUid());

        await historical([past, inside]);
        // Someone adds notes to August's kickoff, and Wednesday's lunch is deleted.
        await delta([removed(past.id), removed(inside.id)]);

        expect(await row(past.iCalUId)).toMatchObject({ status: 'confirmed' });
        expect(await titlesOn('2026-08-10')).toEqual(['Kickoff']);
        expect(await row(inside.iCalUId)).toMatchObject({ status: 'cancelled' });
      });

      it("never undoes the user's own deletion, but an Undo brings back what Outlook says now", async () => {
        const meeting = lunch(graphId(), exchangeUid());

        await delta([meeting]);
        const [stored] = await day('2026-09-23');
        await events.remove(ctx, stored.id);

        await delta([removed(meeting.id)]);

        expect(await row(meeting.iCalUId)).toMatchObject({ is_deleted: true, status: 'cancelled' });
        await events.restore(ctx, stored.id);
        expect(await day('2026-09-23')).toEqual([]);
      });

      it('keeps a status the user set, and cancels the meeting beside it they did not touch', async () => {
        const kept = lunch(graphId(), exchangeUid());
        const untouched = lunch(graphId(), exchangeUid(), { subject: 'Dentist' });

        await delta([kept, untouched]);
        await events.update(ctx, (await row(kept.iCalUId))!.id as string, { status: 'tentative' });

        await delta([removed(kept.id), removed(untouched.id)]);

        expect(await row(kept.iCalUId)).toMatchObject({ status: 'tentative' });
        expect(await row(untouched.iCalUId)).toMatchObject({ status: 'cancelled' });
      });

      it('follows an event moved to another calendar, which re-ids it, instead of cancelling it', async () => {
        const uid = exchangeUid();
        const before = lunch(graphId(), uid);
        // Graph ids are not immutable unless asked for: a move mints a new one.
        const after = lunch(graphId(), uid);

        await delta([before]);
        signalling.send.mockClear();
        // One run: the work calendar reports the old id gone, the family one has the event.
        await job([
          { id: WORK_CALENDAR, events: [removed(before.id)], deltaWindow: WINDOW },
          { id: FAMILY_CALENDAR, events: [after], deltaWindow: WINDOW },
        ]);

        expect(await row(uid)).toMatchObject({ status: 'confirmed', raw_event_id: after.id });
        expect(await titlesOn('2026-09-23')).toEqual(['Lunch with Ada']);
        // Not even for a moment: no cancellation was published and taken back.
        expect(signalling.send).not.toHaveBeenCalled();

        // And deleting it from where it lives now still reaches it.
        await delta([removed(after.id)], { calendarId: FAMILY_CALENDAR });
        expect(await row(uid)).toMatchObject({ status: 'cancelled' });
      });

      it('brings back an event restored from Deleted Items, and cancels it again under its new id', async () => {
        const uid = exchangeUid();
        const original = lunch(graphId(), uid);
        const restored = lunch(graphId(), uid);

        await delta([original]);
        await delta([removed(original.id)]);
        expect(await row(uid)).toMatchObject({ status: 'cancelled' });

        await delta([restored]);
        expect(await row(uid)).toMatchObject({ status: 'confirmed', raw_event_id: restored.id });
        expect(await titlesOn('2026-09-23')).toEqual(['Lunch with Ada']);

        await delta([removed(restored.id)]);
        expect(await row(uid)).toMatchObject({ status: 'cancelled' });
      });

      it('writes nothing, and fails nothing, for an event it never stored', async () => {
        await delta([removed(graphId())]);

        expect(await eventCount()).toBe(0);
        expect(errorsLogged()).toEqual([]);
      });
    });

    describe('rows written before the transform kept the Graph id', () => {
      it('resolves a UID-less event by the identity the transform derives from its Graph id', async () => {
        const meeting = lunch(graphId(), exchangeUid(), { iCalUId: undefined });

        await delta([meeting]);
        await forgetGraphIds();

        await delta([removed(meeting.id)]);

        const [stored] = await dataSource.query(
          `SELECT status, is_deleted FROM ci.events
            WHERE user_id = $1 AND source_system = 'outlook_calendar' AND source_id = $2`,
          [ctx.userId, meeting.id],
        );
        expect(stored).toMatchObject({ status: 'cancelled', is_deleted: false });
      });

      it('learns the Graph id of an older row the next time Graph delivers that event', async () => {
        const meeting = lunch(graphId(), exchangeUid());

        await delta([meeting]);
        await forgetGraphIds();

        // Any change re-delivers it: here, the organizer edits the agenda.
        await delta([{ ...meeting, bodyPreview: 'Agenda: roadmap' }]);
        expect(await row(meeting.iCalUId)).toMatchObject({ raw_event_id: meeting.id });

        await delta([removed(meeting.id)]);
        expect(await row(meeting.iCalUId)).toMatchObject({ status: 'cancelled' });
      });
    });

    describe('a tombstone from a round whose date range was never recorded', () => {
      it('cancels only an event still to come: whatever the range, it began before now', async () => {
        // Relative to now: the round's range began at some point before this job.
        const hourFrom = (offsetDays: number) => {
          const start = Date.now() + offsetDays * DAY_MS;

          return { start: utc(start), end: utc(start + 3_600_000) };
        };

        const lastWeek = lunch(graphId(), exchangeUid(), { subject: 'Retro', ...hourFrom(-7) });
        const nextWeek = lunch(graphId(), exchangeUid(), { subject: 'Planning', ...hourFrom(7) });

        await historical([lastWeek, nextWeek]);
        await delta([removed(lastWeek.id), removed(nextWeek.id)], { window: null });

        expect(await row(lastWeek.iCalUId)).toMatchObject({ status: 'confirmed' });
        expect(await row(nextWeek.iCalUId)).toMatchObject({ status: 'cancelled' });
      });
    });
  },
);
