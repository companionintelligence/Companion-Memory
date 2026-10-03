import { randomUUID } from 'node:crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY WAY A `ci.events` ROW SAYS IT DID NOT HAPPEN, FOR EVERY READER THAT ASKS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two code paths copy a neighbour's coordinate onto an event that has none:
 * `enrich.estimate_location` in the pipeline domain, and the legacy
 * `LocationEstimateService` in maintenance. Both must use only donors that
 * happened, and give estimates only to targets that happened. This file is the
 * one list of cases both real-Postgres specs are held to, so the two cannot
 * drift apart. It sits here because neither domain may import the other's
 * internals.
 *
 * `promote.place` asks the same question of the events it links to a place,
 * and is held to the same list: its real-Postgres spec and the spec of the
 * repair migration that withdrew its earlier links seed each case with
 * {@link insertEvent} (with a venue name) rather than the blocks below.
 *
 * Each case is seeded twice over, so a failure names the clause that broke:
 *
 *  - a DONOR block. An unlocated event that happened (`candidate`), the case's
 *    event 5 minutes later with a coordinate of its own (`donor`), and an event
 *    that happened 60 minutes later with a different coordinate (`fallback`).
 *    The case's event is the nearer, so it wins if it may lend and loses to
 *    `fallback` if it may not. The block also holds the case's event again
 *    without a coordinate (`target`), which gets an estimate only if it
 *    happened.
 *  - an ORPHAN block, a week away. An unlocated event that happened (`orphan`)
 *    whose only neighbour inside the window is the case's event
 *    (`orphanDonor`). With no fallback, a refused donor leaves nothing, and
 *    the legacy service's donor `EXISTS` has to agree with its donor `LATERAL`.
 *
 * Blocks are two weeks apart per case, far outside the 24-hour window, so no
 * donor can reach into another case.
 */

export type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

/** The columns that say whether an event happened, and the system it came from. */
export interface EventLifecycle {
  isDeleted: boolean;
  isPredicted: boolean | null;
  status: string;
  sourceSystem: string;
  metadata: Record<string, unknown>;
}

/** A calendar event that happened: what the column defaults give. */
export const HAPPENED: EventLifecycle = {
  isDeleted: false,
  isPredicted: false,
  status: 'confirmed',
  sourceSystem: 'calendar',
  metadata: {},
};

export interface LifecycleCase {
  /** Unique; the name a failing test reports. */
  name: string;
  lifecycle: EventLifecycle;
  /** Whether the estimators must treat the event as having happened. */
  happened: boolean;
}

/**
 * Every value `ci.events.status` may hold: its CHECK constraint,
 * `events_status_check`. Both specs compare this with the live schema, so a new
 * status fails them until someone decides below whether it happened.
 */
export const EVENT_STATUSES = [
  'tentative',
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
  'rescheduled',
  'planned',
  'in_progress',
  'skipped',
] as const;

/**
 * The calendar's "did not happen" (`DEAD_EVENT_STATUSES`). It is written out
 * here rather than imported, so that changing the calendar's vocabulary also
 * means agreeing to it here.
 */
const DID_NOT_HAPPEN_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'no_show', 'skipped']);

/** A Google Takeout reservation, as `import/datasources/google_purchases.ts` writes one. */
const RESERVATION = { Kind: 'reservation', Name: 'Reservation', Source: 'Google' };

export const EVENT_LIFECYCLE_CASES: readonly LifecycleCase[] = [
  { name: 'deleted', lifecycle: { ...HAPPENED, isDeleted: true }, happened: false },
  { name: 'predicted', lifecycle: { ...HAPPENED, isPredicted: true }, happened: false },
  // NULL is not a prediction: the column defaults to false, and every reader
  // COALESCEs NULL to false.
  { name: 'is_predicted NULL', lifecycle: { ...HAPPENED, isPredicted: null }, happened: true },
  ...EVENT_STATUSES.map((status) => ({
    name: `status ${status}`,
    lifecycle: { ...HAPPENED, status },
    happened: !DID_NOT_HAPPEN_STATUSES.has(status),
  })),
  // The Takeout importer leaves a cancelled reservation 'confirmed' and records
  // the cancellation only as `metadata.Canceled`, a JSON boolean. Its value
  // decides, not its presence.
  {
    name: 'reservation Canceled: true',
    lifecycle: {
      ...HAPPENED,
      sourceSystem: 'google_purchases',
      metadata: { ...RESERVATION, Canceled: true },
    },
    happened: false,
  },
  {
    name: 'reservation Canceled: false',
    lifecycle: {
      ...HAPPENED,
      sourceSystem: 'google_purchases',
      metadata: { ...RESERVATION, Canceled: false },
    },
    happened: true,
  },
];

/** Where the user was, as measured: every `fallback` donor is here. */
export const WHERE_THE_USER_WAS = { lat: 34.0537, lng: -118.2428 };

/** Where the case's event said it would be: every `donor` and `orphanDonor` is here. */
export const WHERE_IT_WAS_TO_BE = { lat: 34.0907, lng: -118.3266 };

export interface SeededLifecycleCase {
  case: LifecycleCase;
  /** Unlocated, happened. 5 minutes before `donor`, 60 before `fallback`. */
  candidate: string;
  /** The case's event, at {@link WHERE_IT_WAS_TO_BE}: the nearest donor, if it may lend. */
  donor: string;
  /** Happened, at {@link WHERE_THE_USER_WAS}: farther in time than `donor`. */
  fallback: string;
  /** The case's event again, unlocated: a target, 5 minutes after `donor`. */
  target: string;
  /** Unlocated, happened. Its only neighbour in the window is `orphanDonor`. */
  orphan: string;
  /** The case's event, at {@link WHERE_IT_WAS_TO_BE}, 5 minutes after `orphan`. */
  orphanDonor: string;
}

/** The first block. Old enough that nothing real on a dev database is near it. */
const FIRST_BLOCK_AT = Date.parse('2019-01-07T15:00:00Z');
const MINUTE_MS = 60_000;
const WEEK_MS = 7 * 24 * 60 * MINUTE_MS;

/** One `ci.entities` base row and its `ci.events` detail row, base first. */
export async function insertEvent(
  query: Query,
  userId: string,
  event: {
    id: string;
    title: string;
    at: number;
    lifecycle: EventLifecycle;
    point: { lat: number; lng: number } | null;
    /** The venue, as an importer or calendar sync writes it. None by default. */
    locationName?: string | null;
  },
): Promise<void> {
  await query(
    `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
     VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
    [event.id, event.title, userId],
  );
  await query(
    `INSERT INTO ci.events
       (event_id, user_id, start_time, source_system, location_coordinates,
        is_deleted, is_predicted, status, metadata, location_name)
     VALUES ($1::uuid, $2, $3, $4,
             CASE WHEN $5::float8 IS NULL THEN NULL
                  ELSE ST_SetSRID(ST_MakePoint($6::float8, $5::float8), 4326)::geography END,
             $7, $8, $9, $10::jsonb, $11)`,
    [
      event.id,
      userId,
      new Date(event.at).toISOString(),
      event.lifecycle.sourceSystem,
      event.point?.lat ?? null,
      event.point?.lng ?? null,
      event.lifecycle.isDeleted,
      event.lifecycle.isPredicted,
      event.lifecycle.status,
      JSON.stringify(event.lifecycle.metadata),
      event.locationName ?? null,
    ],
  );
}

/** Seed every case's two blocks for `userId`. See the file comment for the layout. */
export async function seedLifecycleCases(
  query: Query,
  userId: string,
  cases: readonly LifecycleCase[] = EVENT_LIFECYCLE_CASES,
): Promise<SeededLifecycleCase[]> {
  const seeded: SeededLifecycleCase[] = [];

  for (const [index, lifecycleCase] of cases.entries()) {
    const donorBlock = FIRST_BLOCK_AT + 2 * index * WEEK_MS;
    const orphanBlock = donorBlock + WEEK_MS;
    const ids: SeededLifecycleCase = {
      case: lifecycleCase,
      candidate: randomUUID(),
      donor: randomUUID(),
      fallback: randomUUID(),
      target: randomUUID(),
      orphan: randomUUID(),
      orphanDonor: randomUUID(),
    };
    const theCase = lifecycleCase.lifecycle;
    const label = lifecycleCase.name;

    for (const event of [
      { id: ids.candidate, title: `${label}: candidate`, at: donorBlock, lifecycle: HAPPENED, point: null },
      {
        id: ids.donor,
        title: `${label}: donor`,
        at: donorBlock + 5 * MINUTE_MS,
        lifecycle: theCase,
        point: WHERE_IT_WAS_TO_BE,
      },
      {
        id: ids.target,
        title: `${label}: target`,
        at: donorBlock + 10 * MINUTE_MS,
        lifecycle: theCase,
        point: null,
      },
      {
        id: ids.fallback,
        title: `${label}: fallback`,
        at: donorBlock + 60 * MINUTE_MS,
        lifecycle: HAPPENED,
        point: WHERE_THE_USER_WAS,
      },
      { id: ids.orphan, title: `${label}: orphan`, at: orphanBlock, lifecycle: HAPPENED, point: null },
      {
        id: ids.orphanDonor,
        title: `${label}: orphan donor`,
        at: orphanBlock + 5 * MINUTE_MS,
        lifecycle: theCase,
        point: WHERE_IT_WAS_TO_BE,
      },
    ]) {
      await insertEvent(query, userId, event);
    }

    seeded.push(ids);
  }

  return seeded;
}

/** The values `events_status_check` allows, read from the live schema. */
export async function eventStatusVocabulary(query: Query): Promise<string[]> {
  const rows = (await query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'ci.events'::regclass
        AND conname = 'events_status_check'`,
  )) as Array<{ definition: string }>;

  if (rows.length !== 1) {
    throw new Error(`Expected one events_status_check constraint on ci.events, found ${rows.length}`);
  }

  return [...rows[0].definition.matchAll(/'([^']+)'::text/g)].map((match) => match[1]);
}

/** An event's location, as either estimator leaves it. */
export interface EventLocation {
  lat: number | null;
  lng: number | null;
  locationSource: string | null;
  donorId: string | null;
}

/** The location of each of `ids`, keyed by id. */
export async function readEventLocations(query: Query, ids: string[]): Promise<Map<string, EventLocation>> {
  const rows = (await query(
    `SELECT event_id,
            ST_Y(location_coordinates::geometry) AS lat,
            ST_X(location_coordinates::geometry) AS lng,
            metadata->>'location_source'       AS location_source,
            inference_sources->>'donor_id'     AS donor_id
       FROM ci.events
      WHERE event_id = ANY($1::uuid[])`,
    [ids],
  )) as Array<{
    event_id: string;
    lat: number | null;
    lng: number | null;
    location_source: string | null;
    donor_id: string | null;
  }>;

  return new Map(
    rows.map((row) => [
      row.event_id,
      {
        lat: row.lat == null ? null : Number(row.lat),
        lng: row.lng == null ? null : Number(row.lng),
        locationSource: row.location_source,
        donorId: row.donor_id,
      },
    ]),
  );
}
