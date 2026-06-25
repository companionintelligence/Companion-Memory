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
   * column (today only `ci.entities`, shared by concept/person/place/file), the
   * `(column, value)` that selects this entity_type's rows. An embedding is an
   * orphan if no row matches BOTH the id AND this discriminator, so a row whose
   * kind was changed out from under it is correctly reaped.
   *
   * `undefined` for single-type tables.
   */
  discriminator?: { column: string; value: string };
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
 * | file             | ci.entities          | entity_id   | entity_type = 'File'          |
 * | item             | ci.inventory         | object_id   | —                             |
 * | message          | ci.agent_memories    | id          | —                             |
 * | note             | ci.notes             | id          | —                             |
 * | person           | ci.entities          | entity_id   | entity_type = 'Person'        |
 * | place            | ci.entities          | entity_id   | entity_type = 'Location'      |
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
  },
  content: { schema: 'ci', table: 'content', idColumn: 'id' },
  event: { schema: 'ci', table: 'events', idColumn: 'event_id' },
  file: {
    schema: 'ci',
    table: 'entities',
    idColumn: 'entity_id',
    discriminator: { column: 'entity_type', value: 'File' },
  },
  item: { schema: 'ci', table: 'inventory', idColumn: 'object_id' },
  message: { schema: 'ci', table: 'agent_memories', idColumn: 'id' },
  note: { schema: 'ci', table: 'notes', idColumn: 'id' },
  person: {
    schema: 'ci',
    table: 'entities',
    idColumn: 'entity_id',
    discriminator: { column: 'entity_type', value: 'Person' },
  },
  place: {
    schema: 'ci',
    table: 'entities',
    idColumn: 'entity_id',
    discriminator: { column: 'entity_type', value: 'Location' },
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
