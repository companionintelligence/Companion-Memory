import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import {
  BaseEntity,
  CalendarEventService,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
  LIVE_EVENT_SQL,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { dataSourceConnection } from '../../__tests__/support/databaseConnection';
import { CalendarFileImporter } from '../datasources/calendar';
import { GooglePurchasesFileImporter } from '../datasources/google_purchases';
import type { FileImporter } from '../datasources/registry';
import type { ImportParams } from '../datasources/timeline';
import { StagedItemEntity } from '../entities/StagedItemEntity';
import { destinationsFor, toCanonical } from '../push/canonical';
import { toEventInput } from '../push/inputs';

import {
  createStagingHarness,
  IMPORT_DATABASE_ENV,
  importDatabase,
  type StagingHarness,
} from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CANCELLED EVENT, FROM THE FILE TO `ci.events.status`, AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two importers stored a cancelled event as 'confirmed', so every reader of the
 * column took it for something that happened: the .ics parser read STATUS and
 * never used it, and the Takeout reservation importer kept Google's
 * `canceled: true` only in metadata.
 *
 * The unit tests pin each hop (parser, `toCanonical`, `toEventInput`). What only
 * a database shows is that the status SURVIVES the hops that are not ours:
 * staging, the bulk INSERT in `CalendarEventService.createDetailed`, and the
 * column itself (`events_status_check`). A key that `repository.create()` does
 * not recognise is dropped without a word, and ci.events DEFAULTs the column,
 * so a lost write would land on a plausible 'confirmed'.
 *
 * The hops are the real ones: the real importer into the real StagedWriter,
 * the staged rows through `toCanonical` / `destinationsFor` / `toEventInput`
 * (what PushStage does for the events destination), and the real service.
 *
 * Invented throughout: venues, ids, `.test` addresses.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/importEventStatus.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

const SERIES_UID = 'weekly-sync@example.test';

/**
 * A Google-style export: a weekly series, one occurrence of it cancelled
 * (a block repeating the master's UID, with that occurrence's RECURRENCE-ID),
 * a one-off meeting cancelled outright, a tentative one, and one from a
 * calendar that writes no STATUS at all.
 */
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/Los_Angeles:20221006T010000',
  'DTEND;TZID=America/Los_Angeles:20221006T020000',
  'RRULE:FREQ=WEEKLY;BYDAY=TH',
  `UID:${SERIES_UID}`,
  'STATUS:CONFIRMED',
  'SUMMARY:Weekly sync',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/Los_Angeles:20221013T010000',
  'DTEND;TZID=America/Los_Angeles:20221013T020000',
  `UID:${SERIES_UID}`,
  'RECURRENCE-ID;TZID=America/Los_Angeles:20221013T010000',
  'STATUS:CANCELLED',
  'SUMMARY:Weekly sync',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20221014T170000Z',
  'DTEND:20221014T180000Z',
  'UID:vendor-review@example.test',
  'STATUS:CANCELLED',
  'SUMMARY:Vendor review',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20221015T170000Z',
  'DTEND:20221015T180000Z',
  'UID:maybe-lunch@example.test',
  'STATUS:TENTATIVE',
  'SUMMARY:Lunch?',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20221016T170000Z',
  'DTEND:20221016T180000Z',
  'UID:no-status@example.test',
  'SUMMARY:A calendar that writes no STATUS',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const RESERVATION = {
  merchantName: 'Harbor Noodle House',
  partySize: 2,
  service: 'Reservations & Waitlist',
  address: 'California, 100 Example Way, Laguna Beach, US',
};

interface StoredEvent {
  source_id: string;
  status: string;
  event_status: string | null;
}

describeWithDatabase(`a cancelled event's status reaches ci.events (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;
  let eventsDataSource: DataSource;
  let service: CalendarEventService;

  const tmpDirs: string[] = [];

  function tmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

    tmpDirs.push(dir);

    return dir;
  }

  /** Run one importer over `root` into a fresh run's StagedWriter, as a real parse does. */
  async function stage(importer: FileImporter, dataSource: string, root: string): Promise<string> {
    const { writer, runId } = await harness.writerFor(dataSource);

    await importer.fileImport({}, { filename: path.basename(root), fullPath: root }, {
      pipeline: writer,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    await writer.settled();

    return runId;
  }

  /**
   * Push what a run staged to the events destination, as PushStage does:
   * staged row to canonical record to event input to the service.
   */
  async function pushEvents(runId: string) {
    const rows = await harness.dataSource.getRepository(StagedItemEntity).find({ where: { runId } });
    const inputs = rows
      .map((row) => toCanonical(row))
      .filter((record) => destinationsFor(record).includes('events'))
      .map((record) => toEventInput(record));

    return service.createDetailed({ userId: harness.userId }, inputs);
  }

  function stored(sourceSystem: string): Promise<StoredEvent[]> {
    return harness.dataSource.query<StoredEvent[]>(
      `SELECT source_id, status, metadata->>'eventStatus' AS event_status
         FROM ci.events
        WHERE user_id = $1::uuid AND source_system = $2
        ORDER BY source_id COLLATE "C"`,
      [harness.userId, sourceSystem],
    );
  }

  /** What the calendar, the planner and Known places count: LIVE_EVENT_SQL, aliased `event`. */
  async function liveSourceIds(sourceSystem: string): Promise<string[]> {
    const rows = await harness.dataSource.query<Array<{ source_id: string }>>(
      `SELECT event.source_id
         FROM ci.events event
        WHERE event.user_id = $1::uuid AND event.source_system = $2 AND ${LIVE_EVENT_SQL}
        ORDER BY event.source_id COLLATE "C"`,
      [harness.userId, sourceSystem],
    );

    return rows.map((row) => row.source_id);
  }

  async function clearEvents(): Promise<void> {
    const userId = harness.userId;

    await harness.dataSource.query(`DELETE FROM ci.events WHERE user_id = $1::uuid`, [userId]);
    await harness.dataSource.query(
      `DELETE FROM ci.entities WHERE owner_user_id = $1::uuid AND entity_type = 'Event'`,
      [userId],
    );
    // Neither carries a foreign key that cleans it up with the user.
    await harness.dataSource.query(`DELETE FROM ci.record_sources WHERE user_id = $1::uuid`, [userId]);
    await harness.dataSource.query(`DELETE FROM ci.graph_deltas WHERE owner_user_id = $1::uuid`, [userId]);
  }

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());

    eventsDataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(IMPORT_DATABASE_ENV),
      entities: [EventEntity, BaseEntity, EventBaseEntity, UserEntity],
      synchronize: false,
      logging: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await eventsDataSource.initialize();

    const logger = {
      setContext: () => undefined,
      log: () => undefined,
      debug: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as LoggerService;

    service = new CalendarEventService(
      eventsDataSource.getRepository(EventEntity),
      eventsDataSource.getRepository(EventBaseEntity),
      { send: async () => undefined } as never,
      eventsDataSource,
      new GraphDeltaWriter(eventsDataSource, logger),
    );
  });

  afterEach(async () => {
    await clearEvents();
  });

  afterAll(async () => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    if (eventsDataSource?.isInitialized) {
      await eventsDataSource.destroy();
    }

    // The harness deletes the user it made, and the rows owned by it.
    await teardown?.();
  });

  it("stores an .ics file's cancelled, tentative and unstated events as the file gave them", async () => {
    const root = tmpDir('ci-ics-status-');

    fs.writeFileSync(path.join(root, 'status.ics'), ICS);

    const results = await pushEvents(await stage(new CalendarFileImporter(), 'calendar', root));

    // Five blocks, five new rows: the override is its own row, not a collapse
    // of the series onto one UID.
    expect(results.map((result) => result.inserted)).toEqual([true, true, true, true, true]);

    expect(await stored('calendar')).toEqual([
      { source_id: 'maybe-lunch@example.test', status: 'tentative', event_status: 'tentative' },
      // No STATUS states nothing, so the column DEFAULT stands and no key is written.
      { source_id: 'no-status@example.test', status: 'confirmed', event_status: null },
      { source_id: 'vendor-review@example.test', status: 'cancelled', event_status: 'cancelled' },
      { source_id: SERIES_UID, status: 'confirmed', event_status: 'confirmed' },
      // 01:00 America/Los_Angeles on 2022-10-13 (PDT, UTC-7) is 08:00Z. The row
      // is kept, and cancelled: it is what stops a calendar synthesizing that
      // occurrence from the series.
      { source_id: `${SERIES_UID}#20221013T080000Z`, status: 'cancelled', event_status: 'cancelled' },
    ]);
  });

  it("leaves a cancelled .ics event out of what the calendar's readers count", async () => {
    const root = tmpDir('ci-ics-status-live-');

    fs.writeFileSync(path.join(root, 'status.ics'), ICS);
    await pushEvents(await stage(new CalendarFileImporter(), 'calendar', root));

    expect(await liveSourceIds('calendar')).toEqual([
      'maybe-lunch@example.test',
      'no-status@example.test',
      SERIES_UID,
    ]);
  });

  it('stores a cancelled Takeout booking and waitlist entry as cancelled, and a live booking as confirmed', async () => {
    const root = tmpDir('ci-reservations-');
    const dir = path.join(root, 'Purchases & Reservations', 'Reservations');

    fs.mkdirSync(dir, { recursive: true });

    const write = (name: string, body: Record<string, unknown>) =>
      fs.writeFileSync(path.join(dir, name), JSON.stringify(body));

    write('action_9001.json', {
      booking: {
        name: 'Booking',
        ...RESERVATION,
        startTime: '2023-10-22T03:30:00Z',
        endTime: '2023-10-22T04:00:00Z',
        canceled: true,
      },
      uniqueId: '9001',
      lastModifiedTime: '2023-10-22T03:38:56.457869Z',
    });
    write('action_9002.json', {
      waitlist: { name: 'Waitlist', ...RESERVATION, createdTime: '2023-11-04T01:10:00Z', canceled: true },
      uniqueId: '9002',
      lastModifiedTime: '2023-11-04T01:12:00.000000Z',
    });
    write('action_9003.json', {
      booking: {
        name: 'Booking',
        ...RESERVATION,
        startTime: '2023-12-02T02:00:00Z',
        endTime: '2023-12-02T03:30:00Z',
      },
      uniqueId: '9003',
      lastModifiedTime: '2023-12-01T20:00:00.000000Z',
    });

    const results = await pushEvents(
      await stage(new GooglePurchasesFileImporter(), 'google_purchases', root),
    );

    expect(results.map((result) => result.inserted)).toEqual([true, true, true]);

    expect(await stored('google_purchases')).toEqual([
      { source_id: 'gpurchase:9001', status: 'cancelled', event_status: 'cancelled' },
      { source_id: 'gpurchase:9002', status: 'cancelled', event_status: 'cancelled' },
      { source_id: 'gpurchase:9003', status: 'confirmed', event_status: null },
    ]);
    expect(await liveSourceIds('google_purchases')).toEqual(['gpurchase:9003']);
  });
});
