import type { DataSource } from 'typeorm';

import type {
  BrowserActivitySearchFields,
  CommunicationSearchFields,
  ContentSearchFields,
  EventSearchFields,
  FileSearchFields,
  ItemSearchFields,
  PersonSearchFields,
} from '@ci/domains/search-ingress';

/**
 * One SQL projection per indexable entity type: the row's identity plus exactly
 * the fields its `searchTexts` builders read, aliased to the builders' input
 * shape so the same functions serve the live listeners (which pass egress
 * objects) and these stages (which pass rows straight from SQL).
 *
 * Shared by the `index.embed_*` and `index.vector_*` stage pairs — the two
 * projections per type would otherwise drift.
 *
 * All loaders are user-scoped even though the sweep already was: a slice can
 * arrive from a dead letter replayed weeks later, and re-scoping is the
 * difference between "not yours" and indexing someone else's row under this
 * user's id.
 *
 * ── CTI aggregates ─────────────────────────────────────────────────────────
 *
 * Events and items keep their title/name + description on their `ci.entities`
 * base row (`entities.entity_id = events.event_id / objects.object_id`), so
 * those two loaders LEFT JOIN the base — LEFT, so an envelope whose base row is
 * missing still indexes its own fields rather than vanishing.
 */

export type LoadedRow<T> = T & { id: string };

export async function loadContentRows(
  dataSource: DataSource,
  userId: string,
  ids: string[],
): Promise<Array<LoadedRow<ContentSearchFields>>> {
  // Content is a CTI aggregate too: the title is the SOLE property of the
  // `ci.entities` base row (stored as `name` — see ContentBaseEntity); the
  // detail table carries body/url/mimetype. The pre-join `c.title` version of
  // this SELECT threw `column c.title does not exist` on every slice, which is
  // what the 1,931 quarantined content rows in the wild were.
  return dataSource.query(
    `SELECT c.id, c.type, n.name AS title, c.text, c.url, c.mimetype
       FROM ci.content c
       LEFT JOIN ci.entities n ON n.entity_id = c.id
      WHERE c.id = ANY($1::uuid[])
        AND c.user_id = $2::uuid`,
    [ids, userId],
  );
}

export async function loadCommunicationRows(
  dataSource: DataSource,
  userId: string,
  ids: string[],
): Promise<Array<LoadedRow<CommunicationSearchFields>>> {
  return dataSource.query(
    `SELECT c.id, c.subject, c.preview, c.content
       FROM ci.communications c
      WHERE c.id = ANY($1::uuid[])
        AND c.user_id = $2::uuid`,
    [ids, userId],
  );
}

export async function loadEventRows(
  dataSource: DataSource,
  userId: string,
  ids: string[],
): Promise<Array<LoadedRow<EventSearchFields>>> {
  return dataSource.query(
    `SELECT e.event_id AS id,
            n.name AS title,
            n.description,
            e.category,
            e.event_type AS "eventType",
            e.location_name AS "locationName",
            e.start_time AS "startTime",
            e.source_system AS "sourceSystem",
            e.metadata
       FROM ci.events e
       LEFT JOIN ci.entities n ON n.entity_id = e.event_id
      WHERE e.event_id = ANY($1::uuid[])
        AND e.user_id = $2::uuid
        AND e.is_deleted IS NOT TRUE`,
    [ids, userId],
  );
}

export async function loadItemRows(
  dataSource: DataSource,
  userId: string,
  ids: string[],
): Promise<Array<LoadedRow<ItemSearchFields>>> {
  return dataSource.query(
    `SELECT i.object_id AS id,
            n.name,
            n.description,
            i.category,
            i.subcategory,
            i.brand,
            i.model,
            i.maintenance_notes AS "maintenanceNotes",
            i.colors,
            i.materials,
            pl.name AS "lastSeenPlaceName"
       FROM ci.objects i
       LEFT JOIN ci.entities n ON n.entity_id = i.object_id
       LEFT JOIN ci.entities pl ON pl.entity_id = i.last_seen_place_entity_id
      WHERE i.object_id = ANY($1::uuid[])
        AND i.user_id = $2::uuid`,
    [ids, userId],
  );
}

export async function loadPersonRows(
  dataSource: DataSource,
  userId: string,
  ids: string[],
): Promise<Array<LoadedRow<PersonSearchFields>>> {
  // Typed identity columns are canonical (migration 20260808070235); the
  // properties bag is the fallback for pre-migration rows — the same
  // COALESCE order PersonEntity's AfterLoad applies. The bag itself goes to the
  // builders RAW; they strip the normalized keys, mirroring the egress split.
  return dataSource.query(
    `SELECT s.entity_id AS id,
            s.name,
            s.description,
            s.properties,
            COALESCE(s.first_name, s.properties->>'first_name') AS "firstName",
            COALESCE(s.middle_name, s.properties->>'middle_name') AS "middleName",
            COALESCE(s.last_name, s.properties->>'last_name') AS "lastName",
            COALESCE(s.birth_date::text, s.properties->>'birth_date') AS "birthDate",
            s.properties->>'email' AS email,
            s.properties->>'nickname' AS nickname,
            s.properties->>'pronouns' AS pronouns,
            s.properties->>'gender' AS gender,
            s.properties->>'job_title' AS "jobTitle",
            s.properties->>'organization' AS organization,
            s.properties->>'department' AS department,
            s.properties->>'website' AS website,
            s.properties->>'address' AS address,
            s.properties->>'street_address' AS "streetAddress",
            s.properties->>'street_address_2' AS "streetAddress2",
            s.properties->>'city' AS city,
            s.properties->>'region' AS region,
            s.properties->>'country' AS country,
            s.properties->>'postal_code' AS "postalCode"
       FROM ci.entities s
      WHERE s.entity_id = ANY($1::uuid[])
        AND s.owner_user_id = $2::uuid
        AND s.entity_type = 'Person'
        AND s.merged_into_entity_id IS NULL`,
    [ids, userId],
  );
}

export async function loadFileRows(
  dataSource: DataSource,
  userId: string,
  ids: string[],
): Promise<Array<LoadedRow<FileSearchFields>>> {
  // Re-applies BOTH halves of `INDEX_EMBED_FILE_SOURCE.predicate`, not just
  // `deleted_at IS NULL` — a slice can arrive from a dead letter replayed after
  // the row changed, same reasoning as `loadEventRows` re-checking `is_deleted`
  // and `loadPersonRows` re-checking the merge tombstone. Without the variant
  // check here, a derived variant (a thumbnail/transcode, which repeats the
  // original's filename with no text of its own) that somehow reached this
  // loader would embed as a near-duplicate of its original instead of being
  // treated as source-row-missing.
  return dataSource.query(
    `SELECT f.id,
            f.title,
            f.description,
            f.filename,
            f.content_type AS "contentType"
       FROM ci.files f
      WHERE f.id = ANY($1::uuid[])
        AND f.user_id = $2::uuid
        AND f.variant = 'ORIGINAL'
        AND f.deleted_at IS NULL`,
    [ids, userId],
  );
}

export async function loadBrowserActivityRows(
  dataSource: DataSource,
  userId: string,
  ids: string[],
): Promise<Array<LoadedRow<BrowserActivitySearchFields>>> {
  return dataSource.query(
    `SELECT b.id, b.title, b.url, b.properties
       FROM ci.browser_activity b
      WHERE b.id = ANY($1::uuid[])
        AND b.user_id = $2::uuid`,
    [ids, userId],
  );
}
