import { INDEXABLE_ENTITIES, type IndexableEntity } from '@ci/domains/search-next';

/**
 * Describes where the source row for a given search `entity_type` lives, so the
 * orphan-cleanup routine can decide which `(entity_type, entity_id)` rows in
 * `ci_search.embeddings` / `ci_search.vectors` no longer have a backing row and
 * are therefore dead index entries.
 *
 * The mapping is derived from the `*SearchIndexListener`s (which load the row
 * they index) and the corresponding TypeORM entities' `@Entity` / `@PrimaryColumn`
 * decorators — NOT guessed. See the listeners in `./listeners/*` and the entity
 * files for each `service`/`entity` below.
 */
export interface EntitySource {
  /** Postgres schema of the source table (always `ci` today). */
  schema: string;
  /** Source table name. */
  table: string;
  /** Primary-key / identity column whose value equals `ci_search.*.entity_id`. */
  idColumn: string;
  /**
   * For tables that hold MORE than one search entity_type behind a discriminator
   * column (today only `ci.entities`, shared by concept/person/place), the
   * `(column, value)` that selects this entity_type's rows. An embedding is an
   * orphan if no row matches BOTH the id AND this discriminator, so a row whose
   * kind was changed out from under it is correctly reaped.
   *
   * `undefined` for single-type tables.
   */
  discriminator?: { column: string; value: string };
  /**
   * Extra SQL predicate (over source alias `s`) the BACKFILL sweep applies so
   * rows that must never (re-)index are not treated as "missing". Used by every
   * type whose table carries a merge tombstone — the ci.entities-backed ones
   * (`merged_into_entity_id`), `item` (`ci.objects.merged_into_object_id`) and
   * `product` (`ci.product_models.merged_into_product_id`): a merge deletes the
   * tombstone's embedding+vector, and without this filter the sweep would
   * re-find and re-index it via PersonCreatedEvent. `file` uses it for the
   * non-tombstone equivalent — the variant/soft-delete population its pipeline
   * stage already restricts itself to.
   *
   * NOT applied by the ORPHAN sweep: a row excluded here still exists, so it is
   * not an orphan. Narrowing this can only make the backfill enqueue less; it
   * can never make the sweep delete more.
   */
  backfillPredicate?: string;
}

/**
 * entity_type → source table mapping, confirmed against the listeners + entities:
 *
 * | entity_type      | source table         | id column   | discriminator                 |
 * |------------------|----------------------|-------------|-------------------------------|
 * | answer           | ci.answers           | answer_id   | —                             |
 * | browser-activity | ci.browser_activity  | id          | —                             |
 * | communication    | ci.communications    | id          | — (composite PK; id is unique)|
 * | concept          | ci.entities          | entity_id   | entity_type = 'Concept'       |
 * | content          | ci.content           | id          | —                             |
 * | event            | ci.events            | event_id    | —                             |
 * | file             | ci.files             | id          | — (see below)                 |
 * | file-chunk       | ci.file_chunks       | id          | —                             |
 * | item             | ci.objects         | object_id   | — (live rows only, see below) |
 * | message          | ci.agent_memories    | id          | —                             |
 * | note             | ci.notes             | id          | —                             |
 * | person           | ci.entities          | entity_id   | entity_type = 'Person'        |
 * | place            | ci.entities          | entity_id   | entity_type = 'Location'      |
 * | position         | ci.position          | id          | downsample: hour × 3-dec cell |
 * | product          | ci.product_models    | product_id  | — (live rows only, see below) |
 * | receipt          | ci.receipts          | receipt_id  | —                             |
 * | thread           | ci.threads           | thread_id   | —                             |
 *
 * NOTE: `ci.communications` has a composite PK (id, time, user_id), but the
 * search index keys on `id` alone (the listener upserts `entityId: communication.id`),
 * and `id` is unique per row, so checking `id` existence is correct.
 */
export const ENTITY_SOURCE_MAP: Readonly<Record<IndexableEntity, EntitySource>> = {
  answer: { schema: 'ci', table: 'answers', idColumn: 'answer_id' },
  'browser-activity': { schema: 'ci', table: 'browser_activity', idColumn: 'id' },
  communication: { schema: 'ci', table: 'communications', idColumn: 'id' },
  concept: {
    schema: 'ci',
    table: 'entities',
    idColumn: 'entity_id',
    discriminator: { column: 'entity_type', value: 'Concept' },
    backfillPredicate: 's.merged_into_entity_id IS NULL',
  },
  content: { schema: 'ci', table: 'content', idColumn: 'id' },
  // Mirrors INDEX_EMBED_EVENT_SOURCE.predicate (pipeline domain; not importable
  // from here). Without it the sweep's LEFT JOIN against embeddings + index_skips
  // re-found every planned block on every pass and re-enqueued it, and the
  // listener refused it on arrival without recording a skip — the exact
  // non-convergence index_skips was created to end, at one row per block.
  event: {
    schema: 'ci',
    table: 'events',
    idColumn: 'event_id',
    backfillPredicate: "s.is_deleted IS NOT TRUE AND s.event_type <> 'planned_block'",
  },
  // `ci.files`, NOT the `ci.entities` graph node of `entity_type = 'File'`.
  //
  // Both exist, they are 1:1, and their ids are DIFFERENT: GraphIngest mints a
  // fresh `entity_id` for the File node rather than reusing the file's own uuid
  // (measured on the live appliance: 7,775 File nodes, 12,823 `ci.files` rows,
  // ZERO id overlap). Every writer of `entity_type = 'file'` index rows keys on
  // `ci.files.id`:
  //   - `FileSearchIndexListener` upserts `entityId: file.id` (a `ci.files` row
  //     loaded by `FileService.findById`), and
  //   - `FileEmbedStage` / `FileVectorStage` share `INDEX_EMBED_FILE_SOURCE`,
  //     which is `ci.files` / `id`.
  // Pointing the map at the graph node made the orphan sweep's EXISTS check miss
  // EVERY written row, so it deleted the entire `file` index nightly — and made
  // `SearchIndexBackfillService` re-enqueue graph-node ids the listener then
  // dropped as "File not found", so nothing ever grew back.
  //
  // Deliberately NO discriminator on `variant`: `FileService.update` emits
  // `FileUpdatedEvent` for any variant, so the listener can legitimately index a
  // PREVIEW row, and a discriminator here would reap that as an orphan.
  file: {
    schema: 'ci',
    table: 'files',
    idColumn: 'id',
    // Backfill-only (the sweep never applies this), and an exact mirror of
    // `INDEX_EMBED_FILE_SOURCE.predicate`: derived variants repeat the
    // original's filename with no text of their own, and a soft-deleted file
    // must not be re-indexed. Without it the backfill would re-enqueue the
    // 5,048 PREVIEW rows the pipeline deliberately excludes.
    backfillPredicate: "s.variant = 'ORIGINAL' AND s.deleted_at IS NULL",
  },
  'file-chunk': { schema: 'ci', table: 'file_chunks', idColumn: 'id' },
  // Owned units tombstone on merge exactly like the ci.entities-backed types:
  // ObjectMergeService.mergeObjects sets `merged_into_object_id` and DELETES the
  // loser's embedding + vector. Without this predicate the sweep re-finds the
  // tombstone (it has no embedding any more, by design) and re-indexes it via
  // ItemCreatedEvent, resurrecting a thing the user merged away.
  item: {
    schema: 'ci',
    table: 'objects',
    idColumn: 'object_id',
    backfillPredicate: 's.merged_into_object_id IS NULL',
  },
  message: { schema: 'ci', table: 'agent_memories', idColumn: 'id' },
  note: { schema: 'ci', table: 'notes', idColumn: 'id' },
  person: {
    schema: 'ci',
    table: 'entities',
    idColumn: 'entity_id',
    discriminator: { column: 'entity_type', value: 'Person' },
    // Archived (forgotten) people are kept out on purpose, like merge tombstones.
    backfillPredicate: 's.merged_into_entity_id IS NULL AND s.is_active IS NOT FALSE',
  },
  place: {
    schema: 'ci',
    table: 'entities',
    idColumn: 'entity_id',
    discriminator: { column: 'entity_type', value: 'Location' },
    backfillPredicate: 's.merged_into_entity_id IS NULL',
  },
  position: {
    schema: 'ci',
    table: 'position',
    idColumn: 'id',
    // Same local-hour × 3-decimal cell as PositionSearchIndexListener.
    backfillPredicate: `s.location IS NOT NULL AND COALESCE(btrim(s.address), '') <> '' AND s.id = (
      SELECT p2.id FROM ci.position p2
      JOIN ci.users u ON u.id = p2.user_id
       WHERE p2.user_id = s.user_id
         AND p2.location IS NOT NULL
         AND COALESCE(btrim(p2.address), '') <> ''
         AND date_trunc('hour', p2.time AT TIME ZONE COALESCE(NULLIF(btrim(u.timezone), ''), 'UTC'))
           = date_trunc('hour', s.time AT TIME ZONE COALESCE(NULLIF(btrim(u.timezone), ''), 'UTC'))
         AND round(ST_Y(p2.location::geometry)::numeric, 3) = round(ST_Y(s.location::geometry)::numeric, 3)
         AND round(ST_X(p2.location::geometry)::numeric, 3) = round(ST_X(s.location::geometry)::numeric, 3)
       ORDER BY p2.time, p2.id
       LIMIT 1
    )`,
  },
  // Catalog models carry their OWN merge tombstone column (`merged_into_product_id`,
  // the ci.product_models twin of `merged_into_entity_id`), so the same
  // exclusion the ci.entities-backed types use applies here: a merged-away model
  // must not be re-found and re-indexed by the sweep.
  product: {
    schema: 'ci',
    table: 'product_models',
    idColumn: 'product_id',
    backfillPredicate: 's.merged_into_product_id IS NULL',
  },
  receipt: { schema: 'ci', table: 'receipts', idColumn: 'receipt_id' },
  // Archived tasks are excluded from the sweep rather than skipped by the
  // listener: an archived row is not going to be re-embedded, so re-finding it
  // on every pass is the same non-convergence ci_search.index_skips was created
  // to end. Live statuses stay eligible so a reopened task is re-indexed.
  task: {
    schema: 'ci',
    table: 'tasks',
    idColumn: 'id',
    backfillPredicate: "s.status <> 'archived'",
  },
  thread: { schema: 'ci', table: 'threads', idColumn: 'thread_id' },
};

/**
 * Compile-time guard: every IndexableEntity has a source mapping. If a new type
 * is added to INDEXABLE_ENTITIES without a mapping here, this throws at module
 * load (during tests / boot) rather than silently leaving that type's orphans
 * un-reapable.
 */
for (const entityType of INDEXABLE_ENTITIES) {
  if (ENTITY_SOURCE_MAP[entityType] == null) {
    throw new Error(`Missing ENTITY_SOURCE_MAP entry for indexable entity type "${entityType}"`);
  }
}
