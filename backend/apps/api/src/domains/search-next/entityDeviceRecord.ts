/**
 * The per-type fields a device record carries beyond its search text, as SQL over
 * an index row (`entity_type`, `entity_id`, `user_id`): `related_id` (the row it
 * belongs with) and `detail` (a few display fields as JSON). Read by the offline
 * record page on the phone; see docs/architecture/mobile-local-search-plan.md,
 * "Revision 2026-10-21".
 *
 * Same shape as {@link entityTimeSql}: a per-type primary-key lookup, run once
 * per written row. One `LEFT JOIN LATERAL` returns both columns, so a write pays
 * one lookup, not one per column.
 *
 * What is deliberately NOT here holds the line the plan drew — names on the
 * device, no dossiers: no birth dates, no card digits or license keys, no
 * `dossier`, `properties`, raw `metadata` or `source_data`. Coordinates ARE
 * here since 2026-10-22 (Kyle: the replica is encrypted now), so the map
 * filters work offline.
 *
 * Version 2 (2026-10-22) added what the explorer's filters read, so every
 * filter but semantic search applies offline (`api/powersync/localList.ts`):
 *   source_system   the How filter (connectors), on every type that has it
 *   from_id, to_ids a message's sender and recipients as person ids (the
 *                   Who filter; direction binds it to one role)
 *   people          an event's participants and organizer as person ids
 *   location_id     an event's place as a place id (the Where filter, with
 *                   `location_name` already there)
 *   lat, lng        an event's coordinates, a place's point
 *
 * 2026-10-23: `browser-activity` and `file-chunk` became device-indexed. Both
 * get their fields here without a version bump — no existing type's recipe
 * changed, so the 600k records already on phones need not be re-sent; the two
 * new types have no records yet and are written by the vector stage / listener
 * re-runs that backfill them (see `pipeline/versions.ts` and the file-chunk
 * lane in `SearchIndexBackfillService`).
 *   browser-activity  url, domain, action_type, duration_seconds, source_system
 *                     (not page_summary: free text the body does not carry, and
 *                     not is_incognito / contains_sensitive: rows flagged so
 *                     are still indexed on the appliance, and the phone shows
 *                     what the appliance shows)
 *   file-chunk        related_id = the file; filename, section_title, and the
 *                     page / sheet from source_locator, flattened so the page
 *                     prints "Page 4" without knowing the locator's shape
 */

/**
 * The recipe below, as a number. Bump it whenever a type's fields change:
 * `MobileSearchDocumentDetailCron` re-derives every document whose
 * `detail_version` is lower, in batches, without re-running the tsvector.
 */
export const DEVICE_RECORD_VERSION = 3;

/**
 * Fixed namespace for the conversation uuid (`uuid_generate_v5`). Arbitrary but
 * permanent: changing it re-keys every conversation on every device.
 */
export const CONVERSATION_NAMESPACE = 'b3a7c1d2-5e4f-4a6b-9c8d-7e6f5a4b3c2d';

/**
 * Participants beyond this many characters of JSON are cut to the sender alone
 * and flagged, so one group message cannot balloon a row. Participants measured
 * 144 B average, 730 B p99, 1,880 B max on 2026-10-21.
 */
export const DEVICE_PARTICIPANTS_MAX_CHARS = 1024;

/**
 * `jsonb_strip_nulls` keeps absent fields out of the payload entirely, so a type
 * with nothing to show writes NULL rather than `{}` (see the outer NULLIF).
 */
/**
 * The ORIGINAL file's id when a PREVIEW rendition of it exists, else null: what the phone
 * downloads through `GET /api/files/:id/preview` and keys its preview store by. The
 * original's id, not the rendition's, so a re-rendered preview keeps its key. The caller
 * puts the `::uuid` cast inside a CASE branch, so a non-uuid external id is never cast.
 */
function previewOf(fileId: string): string {
  return `(SELECT v.parent_id FROM ci.files v
            WHERE v.parent_id = ${fileId} AND v.variant = 'PREVIEW' AND v.deleted_at IS NULL
            LIMIT 1)`;
}

function obj(fields: string): string {
  return `jsonb_strip_nulls(jsonb_build_object(${fields}))`;
}

/**
 * `SELECT related_id, detail` for one index row, as a lateral subquery body.
 * `alias` is the index row's alias (`v` in the upsert, `d` in the refresh).
 */
export function entityDeviceRecordSql(alias: string): string {
  const type = `${alias}.entity_type`;
  const id = `${alias}.entity_id`;
  const user = `${alias}.user_id`;

  return `
    SELECT r.related_id, NULLIF(r.detail, '{}'::jsonb) AS detail
      FROM (
        SELECT NULL::uuid AS related_id, NULL::jsonb AS detail WHERE false

        UNION ALL
        SELECT CASE WHEN c.thread_id IS NULL OR btrim(c.thread_id) = '' THEN NULL
                    ELSE uuid_generate_v5('${CONVERSATION_NAMESPACE}'::uuid,
                                          ${user}::text || '|' || coalesce(c.source_system, '') || '|' || c.thread_id)
               END,
               ${obj(`
                 'communication_type', c.communication_type::text,
                 'direction', c.direction::text,
                 'source_system', c.source_system,
                 'from_id', c.from_entity_id,
                 'to_ids', CASE WHEN cardinality(c.to_entity_ids) > 0 THEN to_jsonb(c.to_entity_ids) END,
                 'participants', CASE WHEN length(c.participants_metadata::text) <= ${DEVICE_PARTICIPANTS_MAX_CHARS}
                                      THEN c.participants_metadata
                                      ELSE jsonb_strip_nulls(jsonb_build_object('from', c.participants_metadata -> 'from'))
                                 END,
                 'participants_truncated', CASE WHEN length(c.participants_metadata::text) > ${DEVICE_PARTICIPANTS_MAX_CHARS}
                                                THEN true END`)}
          FROM ci.communications c
         WHERE ${type} = 'communication' AND c.id = ${id}

        UNION ALL
        SELECT e.parent_event_id,
               ${obj(`
                 'end_time', e.end_time,
                 'is_all_day', e.is_all_day,
                 'location_name', e.location_name,
                 'location_id', e.location_entity_id,
                 'lat', ST_Y(e.location_coordinates::geometry),
                 'lng', ST_X(e.location_coordinates::geometry),
                 'category', e.category,
                 'event_type', e.event_type,
                 'status', e.status,
                 'source_system', e.source_system,
                 'people', CASE WHEN cardinality(e.participant_entity_ids) > 0 OR e.organizer_entity_id IS NOT NULL
                                THEN to_jsonb(array_remove(array_append(e.participant_entity_ids, e.organizer_entity_id), NULL))
                           END`)}
          FROM ci.events e
         WHERE ${type} = 'event' AND e.event_id = ${id}

        UNION ALL
        SELECT ct.event_id,
               ${obj(`'type', ct.type, 'mimetype', ct.mimetype, 'source_url', ct.source_url, 'source_system', ct.source_system,
                 'preview_id', CASE WHEN ct.external_id_kind = 'file' THEN ${previewOf('ct.external_id::uuid')} END`)}
          FROM ci.content ct
         WHERE ${type} = 'content' AND ct.id = ${id}

        UNION ALL
        SELECT f.parent_id,
               ${obj(`'content_type', f.content_type, 'size', f.size, 'width', f.width, 'height', f.height,
                 'preview_id', ${previewOf('f.id')}`)}
          FROM ci.files f
         WHERE ${type} = 'file' AND f.id = ${id}

        UNION ALL
        SELECT NULL::uuid,
               ${obj(`'first_name', en.first_name, 'last_name', en.last_name, 'is_self', en.is_self`)}
          FROM ci.entities en
         WHERE ${type} = 'person' AND en.entity_id = ${id}

        UNION ALL
        SELECT en.parent_place_id,
               ${obj(`
                 'place_kind', en.place_kind,
                 'lat', ST_Y(en.location_point::geometry),
                 'lng', ST_X(en.location_point::geometry)`)}
          FROM ci.entities en
         WHERE ${type} = 'place' AND en.entity_id = ${id}

        UNION ALL
        SELECT rc.event_id,
               ${obj(`
                 'merchant_name', rc.merchant_name,
                 'total_minor', rc.total_minor,
                 'currency', rc.currency,
                 'source_system', rc.source_system,
                 'location_id', rc.place_entity_id`)}
          FROM ci.receipts rc
         WHERE ${type} = 'receipt' AND rc.receipt_id = ${id}

        UNION ALL
        SELECT NULL::uuid,
               ${obj(`'brand', pm.brand, 'model_number', pm.model_number, 'category', pm.category, 'source_system', pm.source_system`)}
          FROM ci.product_models pm
         WHERE ${type} = 'product' AND pm.product_id = ${id}

        UNION ALL
        SELECT tk.parent_id,
               ${obj(`
                 'status', tk.status,
                 'priority', tk.priority,
                 'due_at', tk.due_at,
                 'scheduled_for', tk.scheduled_for,
                 'completed_at', tk.completed_at`)}
          FROM ci.tasks tk
         WHERE ${type} = 'task' AND tk.id = ${id}

        UNION ALL
        SELECT NULL::uuid, ${obj(`'status', t.status::text, 'last_message_at', t.last_message_at`)}
          FROM ci.threads t
         WHERE ${type} = 'thread' AND t.thread_id = ${id}

        UNION ALL
        SELECT NULL::uuid,
               ${obj(`'category', o.category, 'brand', o.brand, 'model', o.model, 'source_system', o.source_system`)}
          FROM ci.objects o
         WHERE ${type} = 'item' AND o.object_id = ${id}

        UNION ALL
        SELECT NULL::uuid,
               ${obj(`
                 'url', b.url,
                 'domain', b.domain,
                 'action_type', b.action_type,
                 'duration_seconds', b.duration_seconds,
                 'source_system', b.source_system`)}
          FROM ci.browser_activity b
         WHERE ${type} = 'browser-activity' AND b.id = ${id}

        UNION ALL
        SELECT fc.file_id,
               ${obj(`
                 'filename', (SELECT f.filename FROM ci.files f WHERE f.id = fc.file_id),
                 'section_title', fc.section_title,
                 'page', coalesce(fc.source_locator ->> 'page', fc.source_locator ->> 'pageStart'),
                 'sheet', fc.source_locator ->> 'sheet'`)}
          FROM ci.file_chunks fc
         WHERE ${type} = 'file-chunk' AND fc.id = ${id}
      ) r`;
}
