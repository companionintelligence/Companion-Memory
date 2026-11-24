/**
 * Browse people/places by when they *showed up* in the user's life, not when
 * the row was written.
 *
 * Import / enrich / first-sync parks `ci.entities.created_at` on a handful of
 * calendar days. A People or Places date filter that keys off that column
 * therefore shows "everyone we ingested yesterday" instead of "everyone who
 * appeared yesterday". These queries inner-join to real activity in the active
 * window and take MIN(activity) so Last week groups someone on the day they
 * showed up that week — one row per person/place, never a fan-out onto every
 * day they appeared, and never the connected communications/events themselves.
 *
 * Unfiltered browse keeps the unique full list (no appearance join): people
 * with no events/comms still belong on that list. `time_source = 'ingest'`
 * events are excluded because that start_time is the import wall clock;
 * `time_source IS NULL` is kept so legacy calendar times still date a person.
 *
 * A place is also dated only from events that happened ({@link EVENT_HAPPENED_SQL}),
 * because the date is that of a visit: a meeting cancelled at the source, a photo
 * the user deleted or a prediction, linked to a place, does not bring it into
 * the window or move the date it appears at. People are not narrowed that way.
 * Whether the organizer of a cancelled meeting "appeared" is a different
 * question from whether the user was somewhere, and it is not decided here.
 */

import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { EVENT_HAPPENED_SQL } from './eventHappened';

/** Mirrors `TIME_SOURCES.INGEST` without importing the pipeline stage. */
export const INGEST_TIME_SOURCE = 'ingest';

export type AppearanceBrowseOptions = {
  startTime?: Date;
  endTime?: Date;
  afterTime?: Date;
  afterId?: string;
  order?: 'ASC' | 'DESC';
  limit?: number;
};

export function hasDateWindow(options: { startTime?: Date; endTime?: Date }): boolean {
  return options.startTime != null || options.endTime != null;
}

/** Browse is user-scoped; system context has no people/places feed. */
export function ownerUserId(userId: unknown): string | null {
  return typeof userId === 'string' ? userId : null;
}

export function appearanceWindowParams(
  userId: string,
  options: { startTime?: Date; endTime?: Date },
): [string, Date | null, Date | null] {
  return [userId, options.startTime ?? null, options.endTime ?? null];
}

/**
 * Bindings shared by list appearance SQL: user, window, then the
 * keyset cursor and limit.
 */
export function appearanceParams(
  userId: string,
  options: AppearanceBrowseOptions,
): [string, Date | null, Date | null, Date | null, string | null, number | null] {
  return [
    userId,
    options.startTime ?? null,
    options.endTime ?? null,
    options.afterTime ?? null,
    options.afterId ?? null,
    options.limit ?? null,
  ];
}

function windowedEventPredicate(alias: string): string {
  return `${alias}.user_id = $1
           AND ${alias}.time_source IS DISTINCT FROM '${INGEST_TIME_SOURCE}'
           AND ($2::timestamptz IS NULL OR ${alias}.start_time >= $2)
           AND ($3::timestamptz IS NULL OR ${alias}.start_time <= $3)`;
}

function windowedCommunicationPredicate(alias: string): string {
  return `${alias}.user_id = $1
           AND ($2::timestamptz IS NULL OR ${alias}.time >= $2)
           AND ($3::timestamptz IS NULL OR ${alias}.time <= $3)`;
}

/**
 * Person appearance hits: organizer, participant, communication from, communication to.
 * MIN(at) per person is taken by the outer GROUP BY.
 */
function personAppearanceHitsSql(): string {
  return `
             SELECT e.organizer_entity_id AS pid, e.start_time AS at
               FROM ci.events e
              WHERE ${windowedEventPredicate('e')}
                AND e.organizer_entity_id IS NOT NULL
             UNION ALL
             SELECT p.pid, e.start_time AS at
               FROM ci.events e
               CROSS JOIN LATERAL unnest(e.participant_entity_ids) AS p(pid)
              WHERE ${windowedEventPredicate('e')}
                AND e.participant_entity_ids IS NOT NULL
             UNION ALL
             SELECT c.from_entity_id AS pid, c.time AS at
               FROM ci.communications c
              WHERE ${windowedCommunicationPredicate('c')}
                AND c.from_entity_id IS NOT NULL
             UNION ALL
             SELECT p.pid, c.time AS at
               FROM ci.communications c
               CROSS JOIN LATERAL unnest(c.to_entity_ids) AS p(pid)
              WHERE ${windowedCommunicationPredicate('c')}
                AND c.to_entity_ids IS NOT NULL`;
}

/**
 * Place appearance hits: events linked to the place that happened. The table is
 * aliased `event`, not `e` as the person hits do, because that is the alias
 * {@link EVENT_HAPPENED_SQL} is written for.
 */
function placeAppearanceHitsSql(): string {
  return `
             SELECT event.location_entity_id AS pid, event.start_time AS at
               FROM ci.events event
              WHERE ${windowedEventPredicate('event')}
                AND event.location_entity_id IS NOT NULL
                AND ${EVENT_HAPPENED_SQL}`;
}

function appearanceCte(hitsSql: string): string {
  return `appearance AS (
      SELECT pid, MIN(at) AS appeared_at
        FROM (${hitsSql}
        ) hits
       WHERE pid IS NOT NULL
       GROUP BY pid
    )`;
}

/**
 * The seek past the cursor ($4 time, $5 id), in `order`. The same rule as
 * `keysetSeek` (common/persistence), written against this query's positional
 * parameters: `$4` is the MILLISECOND the driver read the cursor row's time as,
 * while `appeared_at` is microseconds, so `$4` is a bucket, `[$4, $4 + 1 ms)`,
 * and not a point. Equality on it would match nothing, and `>` on it would
 * match the cursor row's own bucket. The id tiebreak runs the way the time does,
 * in the seek and in the ORDER BY.
 */
function keysetPredicate(order: 'ASC' | 'DESC'): string {
  const end = `$4::timestamptz + interval '1 millisecond'`;
  const inBucket = `appearance.appeared_at >= $4 AND appearance.appeared_at < ${end}`;

  if (order === 'ASC') {
    return `($4::timestamptz IS NULL
           OR appearance.appeared_at >= ${end}
           OR (${inBucket} AND entity.entity_id > $5))`;
  }

  return `($4::timestamptz IS NULL
           OR appearance.appeared_at < $4
           OR (${inBucket} AND entity.entity_id < $5))`;
}

function personEntityPredicate(): string {
  return `entity.entity_type = 'Person'
       AND entity.owner_user_id = $1
       AND entity.is_active IS DISTINCT FROM FALSE
       AND entity.merged_into_entity_id IS NULL`;
}

function placeEntityPredicate(): string {
  return `entity.entity_type = 'Location'
       AND entity.owner_user_id = $1
       AND entity.is_active IS DISTINCT FROM FALSE
       AND entity.merged_into_entity_id IS NULL`;
}

export function personAppearanceListSql(order: 'ASC' | 'DESC' = 'DESC'): string {
  const dir = order === 'ASC' ? 'ASC' : 'DESC';

  return `
    WITH ${appearanceCte(personAppearanceHitsSql())}
    SELECT entity.entity_id AS id, appearance.appeared_at AS "appearedAt"
      FROM ci.entities entity
      INNER JOIN appearance ON appearance.pid = entity.entity_id
     WHERE ${personEntityPredicate()}
       AND ${keysetPredicate(order)}
     ORDER BY appearance.appeared_at ${dir}, entity.entity_id ${dir}
     LIMIT $6`;
}

export function personAppearanceCountSql(): string {
  return `
    WITH ${appearanceCte(personAppearanceHitsSql())}
    SELECT COUNT(*)::int AS n
      FROM ci.entities entity
      INNER JOIN appearance ON appearance.pid = entity.entity_id
     WHERE ${personEntityPredicate()}`;
}

export function placeAppearanceListSql(order: 'ASC' | 'DESC' = 'DESC'): string {
  const dir = order === 'ASC' ? 'ASC' : 'DESC';

  return `
    WITH ${appearanceCte(placeAppearanceHitsSql())}
    SELECT entity.entity_id AS id, appearance.appeared_at AS "appearedAt"
      FROM ci.entities entity
      INNER JOIN appearance ON appearance.pid = entity.entity_id
     WHERE ${placeEntityPredicate()}
       AND ${keysetPredicate(order)}
     ORDER BY appearance.appeared_at ${dir}, entity.entity_id ${dir}
     LIMIT $6`;
}

export function placeAppearanceCountSql(): string {
  return `
    WITH ${appearanceCte(placeAppearanceHitsSql())}
    SELECT COUNT(*)::int AS n
      FROM ci.entities entity
      INNER JOIN appearance ON appearance.pid = entity.entity_id
     WHERE ${placeEntityPredicate()}`;
}

export function mapAppearanceRows(
  rows: Array<{ id: string; appearedAt: Date | string }>,
  type: 'person' | 'place',
): EntityIdentifier<IndexableEntity>[] {
  return rows.map((row) => ({
    id: row.id,
    type,
    sortTime: coerceDate(row.appearedAt),
  }));
}

function coerceDate(value: Date | string): Date {
  if (value instanceof Date) {
    return value;
  }

  return new Date(value);
}
