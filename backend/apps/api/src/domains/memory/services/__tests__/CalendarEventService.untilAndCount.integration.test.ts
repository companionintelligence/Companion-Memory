import { RRule } from 'rrule';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { wallClockInTZ, wallClockToUTC } from '@ci/common/time/zoned';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { calendarEventIdentity } from '../../identity';
import { clearExpansionZoneCache } from '../../recurrence/queries';
import type { CreateEventDto } from '../../types';
import { CalendarEventService } from '../CalendarEventService';
import { EVENT_STATUS_REOPENER } from '../eventStatusReopener';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * A series whose rule has both UNTIL and COUNT, through each way a rule
 * reaches `ci.events`: a create (Google sync, the .ics import, bulk ingest and
 * GraphQL `createEvent(s)` all call `create` or `createDetailed`), an edit, and
 * a row that already holds the rule. RFC 5545 says a rule must not carry both,
 * but calendars write them, and rrule ends the series at whichever comes first.
 * Every case is read back through `findInRange` and compared with rrule walking
 * the same rule with no period budget.
 *
 * Opt-in like the sibling integration specs: set MEMORY_TEST_DATABASE_URL to a
 * migrated database of your own.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/CalendarEventService.untilAndCount] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const ZONE = 'America/Los_Angeles';
const TITLE = 'Standup';
// Monday 28 September 2026, 09:00 in Los Angeles, for half an hour.
const SERIES_START = new Date('2026-09-28T16:00:00Z');
const SERIES_END = new Date('2026-09-28T16:30:00Z');
const FROM = new Date('2026-09-01T00:00:00Z');
const TO = new Date('2027-01-01T00:00:00Z');
const OPEN_ENDED = 'RRULE:FREQ=WEEKLY;BYDAY=MO';

/** The series' Mondays until UNTIL (20 October, 16:00Z) cuts it off. */
const MONDAYS = [
  '2026-09-28T16:00:00.000Z',
  '2026-10-05T16:00:00.000Z',
  '2026-10-12T16:00:00.000Z',
  '2026-10-19T16:00:00.000Z',
];

/** Each rule as a calendar stores it, UNTIL in UTC, and the starts it means. */
const CASES = [
  {
    label: 'UNTIL ends it, written before COUNT',
    rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261020T160000Z;COUNT=10',
    expected: MONDAYS,
  },
  {
    label: 'UNTIL ends it, written after COUNT',
    rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10;UNTIL=20261020T160000Z',
    expected: MONDAYS,
  },
  {
    label: 'COUNT ends it, written before UNTIL',
    rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3;UNTIL=20261231T235959Z',
    expected: MONDAYS.slice(0, 3),
  },
  {
    label: 'COUNT ends it, written after UNTIL',
    rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z;COUNT=3',
    expected: MONDAYS.slice(0, 3),
  },
];

/** A wall clock as the fake-UTC date rrule walks. */
function floating(instant: Date): Date {
  const wall = wallClockInTZ(instant, ZONE);

  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second));
}

/**
 * The series' starts in the window as rrule computes them on its own: walked in
 * the zone's wall clock from DTSTART with UNTIL moved into that wall clock, no
 * budget, each date mapped back to the instant it happens at.
 */
function rruleStarts(rule: string): string[] {
  const options = RRule.parseString(rule.replace(/^RRULE:/, ''));

  if (options.until) {
    options.until = floating(options.until);
  }

  return new RRule({ ...options, dtstart: floating(SERIES_START) })
    .all()
    .map((date) =>
      wallClockToUTC(
        {
          year: date.getUTCFullYear(),
          month: date.getUTCMonth() + 1,
          day: date.getUTCDate(),
          hour: date.getUTCHours(),
          minute: date.getUTCMinutes(),
          second: date.getUTCSeconds(),
        },
        ZONE,
      ),
    )
    .filter((start) => start < TO && start.getTime() + 30 * 60_000 >= FROM.getTime())
    .map((start) => start.toISOString());
}

describeWithDb(`CalendarEventService — a rule with both UNTIL and COUNT (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: CalendarEventService;
  let uid: string;

  const ctx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  function master(rule: string): CreateEventDto {
    const identity = calendarEventIdentity(uid);

    return {
      title: TITLE,
      event_type: 'calendar_event',
      start_time: SERIES_START,
      end_time: SERIES_END,
      status: 'confirmed',
      source_type: 'ETL',
      source_system: identity?.system,
      source_id: identity?.id,
      is_recurring: true,
      metadata: { recurrenceRule: [rule], recurrenceTimeZone: ZONE },
    };
  }

  /** The starts the calendar shows for the series: its master row and every occurrence. */
  async function seriesStarts(): Promise<string[]> {
    const events = await service.findInRange(ctx, FROM, TO);

    return events.filter((event) => event.title === TITLE).map((event) => event.startTime.toISOString());
  }

  async function storedRule(id: string): Promise<unknown> {
    const [row] = await dataSource.query(`SELECT metadata FROM ci.events WHERE event_id = $1`, [id]);

    return row.metadata.recurrenceRule;
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
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/CalendarEventService.untilAndCount');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'UNTIL and COUNT fixture', $2, 'x', true, 'UTC')`,
      [ctx.userId, `until-count.${ctx.userId}@example.test`],
    );

    service = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      { send: jest.fn(async () => undefined) } as never,
      dataSource,
      new GraphDeltaWriter(dataSource, noopLogger),
      { notifyEvents: jest.fn(async () => undefined) } as never,
      {
        get: (token: string) =>
          token === EVENT_STATUS_REOPENER
            ? { reopenStatusDecisions: jest.fn(async () => 0) }
            : { reopenTimeDecisions: jest.fn(async () => 0) },
      } as never,
    );
  });

  beforeEach(() => {
    clearExpansionZoneCache();
    uid = `until-count-${uuidv7()}@example.test`;
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

  describe.each(CASES)('$label', ({ rule, expected }) => {
    it('matches what rrule computes unbudgeted', () => {
      expect(rruleStarts(rule)).toEqual(expected);
    });

    it('expands as stored by a create (sync, GraphQL, bulk ingest)', async () => {
      const [stored] = await service.create(ctx, master(rule));

      expect(await storedRule(stored.id)).toEqual([rule]);
      expect(await seriesStarts()).toEqual(rruleStarts(rule));
    });

    it('expands as stored by createDetailed (the .ics import)', async () => {
      const [result] = await service.createDetailed(ctx, [master(rule)]);

      expect(await storedRule(result.entity.id)).toEqual([rule]);
      expect(await seriesStarts()).toEqual(rruleStarts(rule));
    });

    it('expands after an edit sets the rule', async () => {
      const [stored] = await service.create(ctx, master(OPEN_ENDED));
      // Every Monday from 28 September to 28 December.
      expect(await seriesStarts()).toHaveLength(14);

      await service.update(ctx, stored.id, {
        metadata: { recurrenceRule: [rule], recurrenceTimeZone: ZONE },
      });

      expect(await storedRule(stored.id)).toEqual([rule]);
      expect(await seriesStarts()).toEqual(rruleStarts(rule));
    });

    it('expands from a row that already holds the rule', async () => {
      // As a row stored before the write-side rule checks would hold it.
      const [stored] = await service.create(ctx, master(OPEN_ENDED));
      await dataSource.query(
        `UPDATE ci.events SET metadata = jsonb_set(metadata, '{recurrenceRule}', $2::jsonb) WHERE event_id = $1`,
        [stored.id, JSON.stringify([rule])],
      );

      expect(await seriesStarts()).toEqual(rruleStarts(rule));
    });
  });
});
