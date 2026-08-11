/**
 * Raw-SQL twin of EventService's CTI aggregate write, for set-based bulk
 * writers that cannot take a module dependency on MemoryModule
 * (BrowserActivityModule, for instance: MemoryModule imports it, so injecting
 * the memory EventService there would cycle). It is a pure statement builder
 * with no imports at all and lives in the common persistence layer, so
 * consumers in any domain can use it without a domain edge or import cycle.
 *
 * Owning the statement here keeps "how to write an Event aggregate in SQL" in
 * ONE place: the `ci.events` detail row plus its 'Event'-discriminated
 * `ci.entities` base row (the sole owner of title/description) land in one
 * statement, so they share one transaction — which is what
 * `events_event_id_entities_fk` (DEFERRABLE INITIALLY DEFERRED) requires when
 * the detail row is written first. Idempotency matches EventService's bulk
 * path: the detail insert targets the provenance-triple arbiter with DO
 * NOTHING, and base rows are written for exactly the inserted set.
 */

/** One event aggregate to fold in. The caller supplies a full provenance triple. */
export interface EventAggregateFoldRow {
  userId: string;
  title: string | null;
  description: string | null;
  eventType: string;
  category: string | null;
  time: Date;
  /** When positive, end_time is derived as time + this many seconds. */
  durationSeconds: number | null;
  sourceType: string;
  sourceSystem: string;
  sourceId: string;
  metadata: Record<string, unknown>;
}

const PARAMS_PER_ROW = 11;

/**
 * Builds the single-statement dual insert for a chunk of event aggregates.
 * The caller runs it via `dataSource.query(sql, params)` and bounds the chunk
 * size itself (each row binds {@link PARAMS_PER_ROW} parameters).
 */
export function buildEventAggregateFold(rows: EventAggregateFoldRow[]): {
  sql: string;
  params: unknown[];
} {
  const params: unknown[] = [];

  const values = rows.map((row, i) => {
    const base = i * PARAMS_PER_ROW;
    params.push(
      row.userId,
      row.title,
      row.description,
      row.eventType,
      row.category,
      row.time,
      row.durationSeconds,
      row.sourceType,
      row.sourceSystem,
      row.sourceId,
      JSON.stringify(row.metadata),
    );

    // Every column is cast explicitly. These tuples sit in a `VALUES` CTE
    // rather than directly under `INSERT INTO ci.events`, so there is no
    // target column to infer a bare parameter's type from.
    return `(
      ci.gen_uuid_v7(),
      $${base + 1}::uuid,
      $${base + 2}::text,
      $${base + 3}::text,
      $${base + 4}::text,
      $${base + 5}::text,
      $${base + 6}::timestamptz,
      CASE WHEN $${base + 7}::int IS NOT NULL AND $${base + 7}::int > 0
        THEN $${base + 6}::timestamptz + make_interval(secs => $${base + 7}::int)
        ELSE NULL END,
      $${base + 8}::text,
      $${base + 9}::text,
      $${base + 10}::text,
      $${base + 11}::jsonb
    )`;
  });

  // `incoming` exists so the tuple list is built once and read by both
  // inserts: the base row needs the title, the detail row no longer has
  // anywhere to put it.
  const sql = `WITH incoming (
       event_id, user_id, title, description, event_type, category,
       start_time, end_time, source_type, source_system, source_id, metadata
     ) AS (
       VALUES ${values.join(', ')}
     ),
     inserted AS (
       INSERT INTO ci.events (
         event_id, user_id, event_type, category,
         start_time, end_time, source_type, source_system, source_id, metadata
       )
       SELECT event_id, user_id, event_type, category,
              start_time, end_time, source_type, source_system, source_id, metadata
         FROM incoming
       ON CONFLICT (user_id, source_type, source_system, source_id)
         WHERE source_id IS NOT NULL
         DO NOTHING
       RETURNING event_id
     )
     INSERT INTO ci.entities
       (entity_id, entity_type, name, description, properties,
        owner_user_id, linked_table, linked_id)
     SELECT i.event_id, 'Event', i.title, i.description, '{}'::jsonb,
            i.user_id, 'events', i.event_id
       FROM inserted
       JOIN incoming i USING (event_id)
     ON CONFLICT (entity_id) DO NOTHING`;

  return { sql, params };
}
