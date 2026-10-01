import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';

/**
 * The time and title backfill — the migration's own UPDATE statements, read
 * verbatim from the file — over rows seeded to look like each writer and each
 * kind of later edit left them, inside one transaction that is rolled back.
 *
 * A base decides whether a later re-delivery reads the row's value as the
 * source's or as someone else's, so a wrong one either overwrites a user's move
 * or rename, or strands the organizer's. What the migration may trust: what a
 * writer recorded of its source (Google's `rawEventSummary`; the clean stage's
 * `start_time_original`), and the absence of the trace every person's edit of
 * that field leaves (`last_moved_at`, `external_sync_status = 'pending'`, a
 * graph delta). Everything else must stay NULL.
 *
 * Only the UPDATEs run, not the ALTER TABLEs: see
 * addEventsSourceStatus.migration.integration.test.ts for why.
 *
 * Opt-in: set MEMORY_TEST_DATABASE_URL to a migrated database of your own.
 */
const MIGRATION = '20261001154235_add_events_source_time_and_title.sql';
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/postgres/migrations');

/** Every `UPDATE ci.events … ;` in the migration's `-- migrate:up` half, verbatim. */
function backfillStatements(): string[] {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');
  const up = down === -1 ? sql : sql.slice(0, down);

  return up.match(/^UPDATE ci\.events\b[\s\S]*?;$/gm) ?? [];
}

async function runBackfill(runner: QueryRunner): Promise<void> {
  for (const statement of backfillStatements()) {
    await runner.query(statement);
  }
}

const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/addEventsSourceTimeAndTitle.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const START = '2026-09-23T19:00:00.000Z';
const END = '2026-09-23T20:00:00.000Z';
// An all-day event as Google delivers it, and where clean.temporal_repair moves it.
const DAY = '2026-12-25T00:00:00.000Z';
const NEXT_DAY = '2026-12-26T00:00:00.000Z';
const PACIFIC_DAY = '2026-12-25T08:00:00.000Z';
const PACIFIC_NEXT_DAY = '2026-12-26T08:00:00.000Z';

const GOOGLE = { rawEventId: 'g', rawEventStatus: 'confirmed', googleCalendarUrl: 'x' };

/** One graph delta a past write recorded for the row. */
interface DeltaSeed {
  source: string;
  fields: Record<string, unknown>;
  at?: string;
}

interface Seed {
  label: string;
  name: string | null;
  sourceType?: string;
  sourceId?: string | null;
  start?: string;
  end?: string | null;
  metadata?: Record<string, unknown>;
  timeSource?: string;
  original?: [string, string | null];
  lastMovedAt?: string;
  externalSyncStatus?: string;
  deltas?: DeltaSeed[];
  based?: { start: string; title: string };
}

interface Bases {
  start: string | null;
  end: string | null;
  recurrence: unknown;
  title: string | null;
}

const SEEDS: Seed[] = [
  // ── time ──────────────────────────────────────────────────────────────────
  { label: 'google, untouched', name: 'Review', metadata: { ...GOOGLE, rawEventSummary: 'Review' } },
  {
    label: 'google, moved by the user',
    name: 'Review',
    metadata: { ...GOOGLE, rawEventSummary: 'Review' },
    lastMovedAt: '2026-09-20T00:00:00Z',
  },
  {
    label: 'google, dragged before last_moved_at existed',
    name: 'Review',
    metadata: { ...GOOGLE, rawEventSummary: 'Review' },
    externalSyncStatus: 'pending',
  },
  {
    label: 'google, details edited before the move stamp',
    name: 'Review',
    metadata: { ...GOOGLE, rawEventSummary: 'Review' },
    deltas: [
      {
        source: 'EventService.update',
        fields: { detail_updated: { new: true } },
        at: '2026-08-20T00:00:00Z',
      },
    ],
  },
  {
    label: 'google, details edited since, never moved',
    name: 'Review',
    metadata: { ...GOOGLE, rawEventSummary: 'Review' },
    deltas: [
      {
        source: 'CalendarEventService.update',
        fields: { detail_updated: { new: true } },
        at: '2026-09-25T00:00:00Z',
      },
    ],
  },
  {
    label: 'google all-day, repaired',
    name: 'Christmas',
    start: PACIFIC_DAY,
    end: PACIFIC_NEXT_DAY,
    metadata: { ...GOOGLE, rawEventSummary: 'Christmas' },
    timeSource: 'repaired',
    original: [DAY, NEXT_DAY],
  },
  {
    label: 'google all-day, repaired then relabelled',
    name: 'Christmas',
    start: PACIFIC_DAY,
    end: PACIFIC_NEXT_DAY,
    metadata: { ...GOOGLE, rawEventSummary: 'Christmas' },
    timeSource: 'source',
    original: [DAY, NEXT_DAY],
  },
  {
    label: 'google all-day, repaired then moved by the user',
    name: 'Christmas',
    start: '2026-12-24T08:00:00Z',
    end: '2026-12-25T08:00:00Z',
    metadata: { ...GOOGLE, rawEventSummary: 'Christmas' },
    timeSource: 'repaired',
    original: [DAY, NEXT_DAY],
    lastMovedAt: '2026-12-01T00:00:00Z',
  },
  {
    label: 'google series master',
    name: 'Standup',
    metadata: {
      ...GOOGLE,
      rawEventSummary: 'Standup',
      recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      recurrenceTimeZone: 'Europe/London',
    },
  },
  {
    label: 'google one-off with only a zone',
    name: 'Review',
    metadata: { ...GOOGLE, rawEventSummary: 'Review', recurrenceTimeZone: 'Europe/London' },
  },
  { label: 'open-ended', name: 'Review', end: null, metadata: { ...GOOGLE, rawEventSummary: 'Review' } },
  // An Outlook row with no start: the stamp is what the source path wrote.
  { label: 'ingest stamp', name: 'Untitled Event', metadata: { outlookEventUrl: 'x' }, timeSource: 'ingest' },

  // ── title ─────────────────────────────────────────────────────────────────
  { label: 'google, no summary', name: 'Untitled Event', metadata: { ...GOOGLE } },
  { label: 'google, empty summary', name: 'Untitled Event', metadata: { ...GOOGLE, rawEventSummary: '' } },
  {
    label: 'google, renamed by the user',
    name: 'Review — bring the numbers',
    metadata: { ...GOOGLE, rawEventSummary: 'Review' },
    deltas: [
      { source: 'CalendarEventService.update', fields: { name: { new: 'Review — bring the numbers' } } },
    ],
  },
  // #2890's row for a cancelled occurrence: the series' title, nothing of its own.
  {
    label: 'google cancelled occurrence',
    name: 'Standup',
    metadata: {
      rawEventId: 'g_20261005',
      rawEventStatus: 'cancelled',
      originalStartTime: { dateTime: START },
    },
  },
  { label: 'outlook, untouched', name: 'Sync', metadata: { outlookEventUrl: 'x' } },
  {
    label: 'outlook, renamed through update',
    name: 'Mine',
    metadata: { outlookEventUrl: 'x' },
    deltas: [{ source: 'CalendarEventService.update', fields: { name: { new: 'Mine' } } }],
  },
  {
    label: 'outlook, renamed under the triggers',
    name: 'Mine',
    metadata: { outlookEventUrl: 'x' },
    deltas: [
      { source: 'db_trigger', fields: { name: { old: 'Sync', new: 'Mine' } }, at: '2026-08-10T00:00:00Z' },
    ],
  },
  {
    label: 'outlook, an update that left the name alone',
    name: 'Sync',
    metadata: { outlookEventUrl: 'x' },
    deltas: [
      {
        source: 'CalendarEventService.update',
        fields: { name: { old: 'Sync', new: 'Sync' }, detail_updated: { new: true } },
        at: '2026-09-25T00:00:00Z',
      },
    ],
  },

  // ── never ─────────────────────────────────────────────────────────────────
  { label: 'planned block', name: 'Write the memo', sourceType: 'planning', metadata: {} },
  { label: 'no source id', name: 'Mine', sourceId: null, metadata: {} },
  {
    label: 'already based',
    name: 'Review',
    metadata: { ...GOOGLE, rawEventSummary: 'Review' },
    based: { start: DAY, title: 'Earlier' },
  },
];

const timeBase = (
  start: string,
  end: string | null = END,
  recurrence: unknown = null,
): Omit<Bases, 'title'> => ({
  start,
  end,
  recurrence,
});
const NO_TIME = { start: null, end: null, recurrence: null };

const EXPECTED: Record<string, Bases> = {
  'google, untouched': { ...timeBase(START), title: 'Review' },
  'google, moved by the user': { ...NO_TIME, title: 'Review' },
  'google, dragged before last_moved_at existed': { ...NO_TIME, title: 'Review' },
  'google, details edited before the move stamp': { ...NO_TIME, title: 'Review' },
  'google, details edited since, never moved': { ...timeBase(START), title: 'Review' },
  'google all-day, repaired': { ...timeBase(DAY, NEXT_DAY), title: 'Christmas' },
  'google all-day, repaired then relabelled': { ...timeBase(DAY, NEXT_DAY), title: 'Christmas' },
  'google all-day, repaired then moved by the user': { ...NO_TIME, title: 'Christmas' },
  'google series master': {
    ...timeBase(START, END, { rule: ['RRULE:FREQ=WEEKLY;BYDAY=MO'], timeZone: 'Europe/London' }),
    title: 'Standup',
  },
  'google one-off with only a zone': { ...timeBase(START), title: 'Review' },
  'open-ended': { ...timeBase(START, null), title: 'Review' },
  'ingest stamp': { ...timeBase(START), title: 'Untitled Event' },
  'google, no summary': { ...timeBase(START), title: 'Untitled Event' },
  'google, empty summary': { ...timeBase(START), title: 'Untitled Event' },
  // Exact: what Google said. The difference from the row is what marks the edit.
  'google, renamed by the user': { ...timeBase(START), title: 'Review' },
  'google cancelled occurrence': { ...timeBase(START), title: 'Standup' },
  'outlook, untouched': { ...timeBase(START), title: 'Sync' },
  'outlook, renamed through update': { ...timeBase(START), title: null },
  'outlook, renamed under the triggers': { ...timeBase(START), title: null },
  'outlook, an update that left the name alone': { ...timeBase(START), title: 'Sync' },
  'planned block': { ...NO_TIME, title: null },
  'no source id': { ...NO_TIME, title: null },
  'already based': { start: DAY, end: null, recurrence: null, title: 'Earlier' },
};

describeWithDb(`${MIGRATION} backfill (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;

  const userId = uuidv7();
  const labels = new Map<string, string>();

  async function bases(): Promise<Record<string, Bases>> {
    const rows: Array<{
      id: string;
      source_start_time: Date | null;
      source_end_time: Date | null;
      source_recurrence: unknown;
      source_title: string | null;
    }> = await runner.query(
      `SELECT event_id AS id, source_start_time, source_end_time, source_recurrence, source_title
         FROM ci.events WHERE user_id = $1`,
      [userId],
    );

    return Object.fromEntries(
      rows.map((row) => [
        labels.get(row.id) as string,
        {
          start: row.source_start_time?.toISOString() ?? null,
          end: row.source_end_time?.toISOString() ?? null,
          recurrence: row.source_recurrence,
          title: row.source_title,
        },
      ]),
    );
  }

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', ...dataSourceConnection(DATABASE_ENV) });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/addEventsSourceTimeAndTitle.migration');

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    await runner.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Backfill fixture', $2, 'x', true, 'America/Los_Angeles')`,
      [userId, `backfill.${userId}@example.test`],
    );

    for (const [index, seed] of SEEDS.entries()) {
      const id = uuidv7();
      labels.set(id, seed.label);

      await runner.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
         VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
        [id, seed.name, userId],
      );
      await runner.query(
        `INSERT INTO ci.events (event_id, user_id, start_time, end_time, source_type, source_system, source_id,
                                metadata, time_source, start_time_original, end_time_original, last_moved_at,
                                external_sync_status, source_start_time, source_title)
         VALUES ($1, $2, $3, $4, $5, 'calendar', $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
        [
          id,
          userId,
          seed.start ?? START,
          seed.end === undefined ? END : seed.end,
          seed.sourceType ?? 'ETL',
          seed.sourceId === null ? null : `${index}-${userId}@example.test`,
          JSON.stringify(seed.metadata ?? {}),
          seed.timeSource ?? null,
          seed.original?.[0] ?? null,
          seed.original?.[1] ?? null,
          seed.lastMovedAt ?? null,
          seed.externalSyncStatus ?? null,
          seed.based?.start ?? null,
          seed.based?.title ?? null,
        ],
      );

      for (const delta of seed.deltas ?? []) {
        await runner.query(
          `INSERT INTO ci.graph_deltas (entity_id, node_type, entity_type, change_type, changed_fields,
                                        change_source, owner_user_id, changed_at)
           VALUES ($1, 'entity', 'Event', 'updated', $2::jsonb, $3, $4, $5)`,
          [id, JSON.stringify(delta.fields), delta.source, userId, delta.at ?? '2026-09-25T00:00:00Z'],
        );
      }
    }
  });

  afterAll(async () => {
    if (runner?.isTransactionActive) {
      await runner.rollbackTransaction();
    }

    await runner?.release();
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  it('sets each base from what the writer recorded, or where nothing records an edit', async () => {
    // Two statements for time, two for title. Pinned so a pattern that stopped
    // matching cannot turn this into a test of nothing.
    expect(backfillStatements()).toHaveLength(4);

    await runBackfill(runner);

    expect(await bases()).toEqual(EXPECTED);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const [before] = await runner.query(
      `SELECT string_agg(ctid::text, ',' ORDER BY event_id) AS ctids FROM ci.events WHERE user_id = $1`,
      [userId],
    );

    await runBackfill(runner);

    const [after] = await runner.query(
      `SELECT string_agg(ctid::text, ',' ORDER BY event_id) AS ctids FROM ci.events WHERE user_id = $1`,
      [userId],
    );
    expect(after.ctids).toBe(before.ctids);
    expect(await bases()).toEqual(EXPECTED);
  });
});
