import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';

/**
 * The location backfill — the migration's own UPDATE statement, read verbatim
 * from the file — over rows seeded to look like each writer and each kind of
 * later edit left them, inside one transaction that is rolled back.
 *
 * A base decides whether a later re-delivery reads the row's place as the
 * source's or as someone else's, so a wrong one either overwrites a person's
 * correction or strands the organizer's. What the migration may trust: what a
 * writer recorded of its source, and the absence of the trace a person's edit
 * leaves (a `detail_updated` graph delta). What a pipeline stage wrote is NOT the
 * source's word and stays out of the base, which is how the merge reads those
 * tags on the row itself. Everything else must stay NULL.
 *
 * Only the UPDATE runs, not the ALTER TABLE: see
 * addEventsSourceStatus.migration.integration.test.ts for why.
 *
 * Opt-in: set MEMORY_TEST_DATABASE_URL to a migrated database of your own.
 */
const MIGRATION = '20261001171454_add_events_source_location.sql';
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
  console.warn(`[memory/addEventsSourceLocation.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const ROMA: [number, number] = [12.4964, 41.9028];
const STAGES: [number, number] = [12.6, 41.8];
const NAME = 'Cafe Roma';

/** One graph delta a past write recorded for the row. */
interface DeltaSeed {
  source: string;
  fields: Record<string, unknown>;
}

interface Seed {
  label: string;
  name: string | null;
  point?: [number, number] | null;
  /** `metadata.location_source`, the pipeline's tag. */
  tag?: string;
  sourceType?: string;
  sourceId?: string | null;
  deltas?: DeltaSeed[];
  /** A link some writer made without `promote.place`'s marker. */
  linked?: boolean;
  based?: { name: string | null; coordinates: number[] | null };
}

const EDIT: DeltaSeed = { source: 'CalendarEventService.update', fields: { detail_updated: { new: true } } };

const SEEDS: Seed[] = [
  // ── what the writer recorded of its source ─────────────────────────────────
  { label: 'google, a name and a point', name: NAME, point: ROMA },
  { label: 'google, a name and no point (the provider was down)', name: NAME },
  { label: 'google, no place', name: null },
  { label: 'google, a blank name', name: '   ' },
  { label: 'a meeting link the organizer put in the place', name: 'Zoom', tag: 'virtual' },
  { label: 'outlook, a room with coordinates', name: 'Room 4', point: ROMA },
  { label: 'a point with no name (an Outlook pin, a photo)', name: null, point: ROMA },

  // ── what a stage wrote is not the source's word ────────────────────────────
  { label: 'placed later by enrich.geocode', name: NAME, point: STAGES, tag: 'geocoded' },
  { label: 'placed later, a city centroid', name: NAME, point: STAGES, tag: 'approximate' },
  { label: 'an estimate on an event with no place', name: null, point: STAGES, tag: 'estimated' },
  { label: 'named by reverse geocoding', name: 'Via Appia 12', point: ROMA, tag: 'reverse_geocoded' },

  // ── a stage's mark on a row it could not have written it for ──────────────
  { label: 'an estimate under a name', name: NAME, point: STAGES, tag: 'estimated' },
  { label: 'a reverse-geocoded name with no point', name: 'Via Appia 12', tag: 'reverse_geocoded' },
  { label: 'a geocoded point with no name', name: null, point: STAGES, tag: 'geocoded' },

  // ── the trace a person's edit leaves ───────────────────────────────────────
  { label: 'edited through update', name: NAME, point: ROMA, deltas: [EDIT] },
  {
    label: 'edited through the older update door',
    name: NAME,
    point: ROMA,
    deltas: [{ source: 'EventService.update', fields: { detail_updated: { new: true } } }],
  },
  {
    label: 'geocoded by the legacy listener, which writes through update',
    name: NAME,
    point: ROMA,
    deltas: [EDIT],
  },
  // A rename or a delta from another writer is not an edit of the place.
  {
    label: 'renamed through update',
    name: NAME,
    point: ROMA,
    deltas: [{ source: 'CalendarEventService.update', fields: { name: { new: 'Mine' } } }],
  },
  {
    label: 'a delta from somewhere else',
    name: NAME,
    point: ROMA,
    deltas: [{ source: 'db_trigger', fields: { detail_updated: { new: true } } }],
  },
  // The link is derived or chosen; neither is what the source delivered.
  { label: 'a link another writer made', name: NAME, point: ROMA, linked: true },

  // ── never ──────────────────────────────────────────────────────────────────
  { label: 'planned block', name: NAME, point: ROMA, sourceType: 'planning' },
  { label: 'no source id', name: NAME, point: ROMA, sourceId: null },
  { label: 'already based', name: NAME, point: ROMA, based: { name: 'Earlier', coordinates: null } },
];

type Base = { name: string | null; coordinates: number[] | null } | null;

const place = (name: string | null, coordinates: number[] | null = null): Base => ({ name, coordinates });

const EXPECTED: Record<string, Base> = {
  'google, a name and a point': place(NAME, ROMA),
  'google, a name and no point (the provider was down)': place(NAME),
  'google, no place': place(null),
  'google, a blank name': place(null),
  'a meeting link the organizer put in the place': place('Zoom'),
  'outlook, a room with coordinates': place('Room 4', ROMA),
  'a point with no name (an Outlook pin, a photo)': place(null, ROMA),

  // The source said a name and no point; the stage placed it. The point is the stage's.
  'placed later by enrich.geocode': place(NAME),
  'placed later, a city centroid': place(NAME),
  // The source said nothing; the estimate is a neighbour's.
  'an estimate on an event with no place': place(null),
  // The source said a point; the name is the reverse geocoder's.
  'named by reverse geocoding': place(null, ROMA),

  'an estimate under a name': null,
  'a reverse-geocoded name with no point': null,
  'a geocoded point with no name': null,

  'edited through update': null,
  'edited through the older update door': null,
  'geocoded by the legacy listener, which writes through update': null,
  'renamed through update': place(NAME, ROMA),
  'a delta from somewhere else': place(NAME, ROMA),
  'a link another writer made': place(NAME, ROMA),

  'planned block': null,
  'no source id': null,
  'already based': place('Earlier'),
};

describeWithDb(`${MIGRATION} backfill (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;

  const userId = uuidv7();
  const labels = new Map<string, string>();

  async function bases(): Promise<Record<string, Base>> {
    const rows: Array<{ id: string; source_location: Base }> = await runner.query(
      `SELECT event_id AS id, source_location FROM ci.events WHERE user_id = $1`,
      [userId],
    );

    return Object.fromEntries(rows.map((row) => [labels.get(row.id) as string, row.source_location]));
  }

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', ...dataSourceConnection(DATABASE_ENV) });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/addEventsSourceLocation.migration');

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    await runner.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Backfill fixture', $2, 'x', true, 'America/Los_Angeles')`,
      [userId, `backfill.${userId}@example.test`],
    );

    const linkTarget = uuidv7();
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, properties, location_point,
                                place_kind, is_active)
       VALUES ($1, 'Location', 'A place', $2, '{}'::jsonb, ST_SetSRID(ST_MakePoint(100, -30), 4326)::geography,
               'address', true)`,
      [linkTarget, userId],
    );

    for (const [index, seed] of SEEDS.entries()) {
      const id = uuidv7();
      labels.set(id, seed.label);

      await runner.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
         VALUES ($1, 'Event', 'Lunch', '{}'::jsonb, $2, 'events', $1)`,
        [id, userId],
      );
      await runner.query(
        `INSERT INTO ci.events (event_id, user_id, start_time, end_time, source_type, source_system, source_id,
                                location_name, location_coordinates, location_entity_id, metadata,
                                source_location)
         VALUES ($1, $2, '2026-09-23T19:00:00Z', '2026-09-23T20:00:00Z', $3, 'calendar', $4, $5,
                 CASE WHEN $6::float8 IS NULL THEN NULL
                      ELSE ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography END,
                 $8, $9::jsonb, $10::jsonb)`,
        [
          id,
          userId,
          seed.sourceType ?? 'ETL',
          seed.sourceId === null ? null : `${index}-${userId}@example.test`,
          seed.name,
          seed.point?.[0] ?? null,
          seed.point?.[1] ?? null,
          seed.linked ? linkTarget : null,
          JSON.stringify(seed.tag ? { location_source: seed.tag } : {}),
          seed.based ? JSON.stringify(seed.based) : null,
        ],
      );

      for (const delta of seed.deltas ?? []) {
        await runner.query(
          `INSERT INTO ci.graph_deltas (entity_id, node_type, entity_type, change_type, changed_fields,
                                        change_source, owner_user_id, changed_at)
           VALUES ($1, 'entity', 'Event', 'updated', $2::jsonb, $3, $4, '2026-09-25T00:00:00Z')`,
          [id, JSON.stringify(delta.fields), delta.source, userId],
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

  it('sets each base from what the writer recorded, and leaves a stage’s value and an edited place alone', async () => {
    // One statement. Pinned so a pattern that stopped matching cannot turn this
    // into a test of nothing.
    expect(backfillStatements()).toHaveLength(1);

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

  it('writes a base the merge reads back as the same place', async () => {
    // The backfill spells a point as two JSON numbers from ST_X/ST_Y; the app
    // compares them with the values a row's own coordinates give it.
    const [id] = [...labels].find(([, label]) => label === 'google, a name and a point') as [string, string];
    const [{ lng, lat, base }] = await runner.query(
      `SELECT ST_X(e.location_coordinates::geometry) AS lng, ST_Y(e.location_coordinates::geometry) AS lat,
              e.source_location AS base
         FROM ci.events e
        WHERE e.event_id = $1`,
      [id],
    );

    expect(base.coordinates).toEqual([lng, lat]);
  });
});
