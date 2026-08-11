/**
 * Raw-SQL twin of ContentService's CTI aggregate write for set-based bulk
 * writers that cannot take a MemoryModule dependency (BrowserActivityModule).
 * Mirrors {@link buildEventAggregateFold}.
 *
 * Detail row + 'Content' base row (sole owner of title) land in one statement.
 * Idempotency matches ContentService bulk: provenance-triple DO NOTHING, then
 * base rows for the inserted set.
 */

export interface ContentAggregateFoldRow {
  userId: string;
  /** Becomes ci.entities.name */
  title: string | null;
  type: string;
  text: string | null;
  url: string | null;
  sourceUrl: string | null;
  sourceType: string;
  sourceSystem: string;
  sourceId: string;
  sourceData: Record<string, unknown>;
  /** Optional; resolved by provenance if omitted. */
  eventId?: string | null;
}

const PARAMS_PER_ROW = 10;

export function buildContentAggregateFold(rows: ContentAggregateFoldRow[]): {
  sql: string;
  params: unknown[];
} {
  const params: unknown[] = [];

  const values = rows.map((row, i) => {
    const base = i * PARAMS_PER_ROW;
    params.push(
      row.userId,
      row.title,
      row.type,
      row.text,
      row.url,
      row.sourceUrl ?? row.url,
      row.sourceType,
      row.sourceSystem,
      row.sourceId,
      JSON.stringify(row.sourceData),
    );

    return `(
      ci.gen_uuid_v7(),
      $${base + 1}::uuid,
      $${base + 2}::text,
      $${base + 3}::text,
      $${base + 4}::text,
      $${base + 5}::text,
      $${base + 6}::text,
      $${base + 7}::text,
      $${base + 8}::text,
      $${base + 9}::text,
      $${base + 10}::jsonb
    )`;
  });

  const sql = `WITH incoming (
       content_id, user_id, title, type, text, url, source_url,
       source_type, source_system, source_id, source_data
     ) AS (
       VALUES ${values.join(', ')}
     ),
     inserted AS (
       INSERT INTO ci.content (
         id, user_id, type, text, url, source_url, source_data,
         event_id, source_type, source_system, source_id
       )
       SELECT
         content_id,
         user_id,
         type,
         text,
         url,
         source_url,
         source_data,
         (
           SELECT e.event_id FROM ci.events e
            WHERE e.user_id = incoming.user_id
              AND e.source_type = incoming.source_type
              AND e.source_system = incoming.source_system
              AND e.source_id = incoming.source_id
            LIMIT 1
         ),
         source_type,
         source_system,
         source_id
       FROM incoming
       ON CONFLICT (user_id, source_type, source_system, source_id)
         WHERE source_id IS NOT NULL
         DO NOTHING
       RETURNING id
     )
     base_inserted AS (
       INSERT INTO ci.entities
         (entity_id, entity_type, name, description, properties,
          owner_user_id, linked_table, linked_id)
       SELECT i.id, 'Content',
              COALESCE(NULLIF(TRIM(inc.title), ''), NULLIF(TRIM(inc.url), ''), 'Untitled'),
              NULL, '{}'::jsonb,
              inc.user_id, 'content', i.id
         FROM inserted i
         JOIN incoming inc ON inc.content_id = i.id
       ON CONFLICT (entity_id) DO NOTHING
       RETURNING entity_id, entity_type, name, description, properties, owner_user_id
     )
     INSERT INTO ci.graph_deltas (
       entity_id, node_type, entity_type, change_type, changed_fields,
       change_source, owner_user_id
     )
     SELECT
       b.entity_id,
       'entity',
       b.entity_type,
       'created',
       jsonb_build_object(
         'name', jsonb_build_object('new', b.name),
         'description', jsonb_build_object('new', b.description),
         'entity_type', jsonb_build_object('new', b.entity_type),
         'properties', jsonb_build_object('new', b.properties)
       ),
       'contentAggregateFold',
       b.owner_user_id
     FROM base_inserted b`;

  return { sql, params };
}
