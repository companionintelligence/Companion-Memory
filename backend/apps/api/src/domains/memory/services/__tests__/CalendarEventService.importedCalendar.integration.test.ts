import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
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
 * Which `ci.events` rows the calendar draws, by type and source, on real rows.
 *
 * The .ics importer writes every VEVENT as `event`, the same type Facebook
 * events and Google reservations get. findInRange keeps the first by its
 * federated `calendar` source and must keep the other two off. The sibling
 * unit spec pins the SQL text; this one runs it against Postgres.
 *
 * Opt-in like the sibling integration specs: set MEMORY_TEST_DATABASE_URL to a
 * migrated database of your own.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/CalendarEventService.importedCalendar] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const FROM = new Date('2025-01-01T00:00:00Z');
const TO = new Date('2025-02-01T00:00:00Z');

describeWithDb(`CalendarEventService.findInRange — imported calendar files (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: CalendarEventService;

  const ctx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  /** A row as the import push hands it to `createDetailed`. */
  function imported(
    title: string,
    eventType: string | undefined,
    identity: { system: string; id: string },
    over: Partial<CreateEventDto> = {},
  ): CreateEventDto {
    return {
      title,
      ...(eventType ? { event_type: eventType } : {}),
      start_time: new Date('2025-01-15T10:00:00Z'),
      end_time: new Date('2025-01-15T11:00:00Z'),
      source_type: 'ci-import-tools',
      source_system: identity.system,
      source_id: identity.id,
      ...over,
    };
  }

  function icsIdentity(): { system: string; id: string } {
    const identity = calendarEventIdentity(`ics-${uuidv7()}@example.test`);

    if (!identity) {
      throw new Error('a UID always yields an identity');
    }

    return identity;
  }

  async function titlesInJanuary(): Promise<string[]> {
    const events = await service.findInRange(ctx, FROM, TO);

    return events.map((event) => event.title ?? '').sort();
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
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/CalendarEventService.importedCalendar');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Imported calendar fixture', $2, 'x', true, 'UTC')`,
      [ctx.userId, `imported-calendar.${ctx.userId}@example.test`],
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

  it('draws an imported calendar file beside synced and hand-made events, and no other `event` rows', async () => {
    await service.createDetailed(ctx, [
      imported('Team Meeting', 'event', icsIdentity()),
      imported('All Day Event', 'event', icsIdentity(), {
        start_time: new Date('2025-01-20T00:00:00Z'),
        end_time: undefined,
        is_all_day: true,
      }),
      imported('Synced meeting', 'calendar_event', icsIdentity()),
      imported('Added by hand', undefined, platformIdentity('self', uuidv7())),
      imported('Facebook party', 'event', platformIdentity('facebook', 'event', uuidv7())),
      imported('Dinner reservation', 'event', platformIdentity('google_purchases', uuidv7())),
    ]);

    expect(await titlesInJanuary()).toEqual([
      'Added by hand',
      'All Day Event',
      'Synced meeting',
      'Team Meeting',
    ]);
  });

  it('keeps a cancelled event from an imported file off, like any other cancelled event', async () => {
    await service.createDetailed(ctx, [
      imported('Team Meeting', 'event', icsIdentity()),
      imported('Called off', 'event', icsIdentity(), { status: 'cancelled' }),
    ]);

    expect(await titlesInJanuary()).toEqual(['Team Meeting']);
  });
});
