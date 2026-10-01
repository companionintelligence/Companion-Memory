import { TAGGABLE_ENTITIES, type TaggableEntity } from './types';

/**
 * One row that must exist, and name the caller as its owner, for a taggable
 * `(entity_type, entity_id)` to count as the caller's.
 *
 * Same shape as search-ingress's `EntitySource`, plus the owner column, which
 * that map never needed. Its answer is not reused: search-ingress imports this
 * domain, so it cannot be imported back. It also has no `action` row, because
 * actions are taggable but not indexed.
 */
export interface OwnedRow {
  schema: string;
  table: string;
  /** Column holding the GlobalUID's id. */
  idColumn: string;
  /**
   * Column naming the owning `ci.users(id)`. Always the column the type's own
   * service scopes id-addressed reads and writes by, so "the caller owns it"
   * here means exactly what it means when that service loads the row.
   */
  ownerColumn: string;
  /**
   * For `ci.entities`, which holds several types behind `entity_type`: the
   * value that selects this type's rows. Without it, a Person id would pass
   * as a `place`.
   */
  discriminator?: { column: string; value: string };
}

/** A node in the `ci.entities` graph, owned through `owner_user_id`. */
const graphNode = (entityType: string): OwnedRow => ({
  schema: 'ci',
  table: 'entities',
  idColumn: 'entity_id',
  ownerColumn: 'owner_user_id',
  discriminator: { column: 'entity_type', value: entityType },
});

/**
 * How to decide whether each taggable entity type belongs to a user. EVERY
 * listed row must match.
 *
 * The four class-table-inheritance types (communication, content, event,
 * item) list both halves: the detail row, which is what their `CtiAggregate`
 * authorizes on, AND the `ci.entities` base row sharing its uuid. The two
 * owner columns agree for every aggregate the services write. They can
 * disagree only when a detail row was attached to another owner's base row (the
 * `/v1` caller-supplied-id shape: `insertBaseRows` resolves a clash on
 * `entity_id` alone). An entity like that belongs to nobody cleanly, so neither
 * owner may rewrite its categories.
 *
 * `file` is `ci.files`, not the `ci.entities` File node: their ids differ, and
 * `file` GlobalUIDs carry the `ci.files` id (see search-ingress's
 * `ENTITY_SOURCE_MAP` for the measurement).
 */
export const TAGGABLE_ENTITY_OWNERSHIP: Readonly<Record<TaggableEntity, readonly OwnedRow[]>> = {
  action: [{ schema: 'ci', table: 'actions', idColumn: 'id', ownerColumn: 'user_id' }],
  'browser-activity': [{ schema: 'ci', table: 'browser_activity', idColumn: 'id', ownerColumn: 'user_id' }],
  communication: [
    { schema: 'ci', table: 'communications', idColumn: 'id', ownerColumn: 'user_id' },
    graphNode('Communication'),
  ],
  concept: [graphNode('Concept')],
  content: [{ schema: 'ci', table: 'content', idColumn: 'id', ownerColumn: 'user_id' }, graphNode('Content')],
  event: [
    { schema: 'ci', table: 'events', idColumn: 'event_id', ownerColumn: 'user_id' },
    graphNode('Event'),
  ],
  file: [{ schema: 'ci', table: 'files', idColumn: 'id', ownerColumn: 'user_id' }],
  item: [
    { schema: 'ci', table: 'objects', idColumn: 'object_id', ownerColumn: 'user_id' },
    graphNode('Item'),
  ],
  note: [{ schema: 'ci', table: 'notes', idColumn: 'id', ownerColumn: 'user_id' }],
  person: [graphNode('Person')],
  place: [graphNode('Location')],
  product: [{ schema: 'ci', table: 'product_models', idColumn: 'product_id', ownerColumn: 'user_id' }],
  receipt: [{ schema: 'ci', table: 'receipts', idColumn: 'receipt_id', ownerColumn: 'user_id' }],
  task: [{ schema: 'ci', table: 'tasks', idColumn: 'id', ownerColumn: 'user_id' }],
  thread: [{ schema: 'ci', table: 'threads', idColumn: 'thread_id', ownerColumn: 'user_id' }],
};

/** A statement answering "does `$1` name a row `$2` owns?" as one boolean, `owned`. */
export interface OwnershipQuery {
  sql: string;
  /** Bound after `$1` (the entity id) and `$2` (the user id): each row's discriminator value. */
  discriminatorParams: string[];
}

/**
 * Builds the {@link OwnershipQuery} for one type. Identifiers come from the
 * static map above, never from input, and are quoted the way
 * `OrphanCleanupService` quotes `ENTITY_SOURCE_MAP`'s. Discriminator values are
 * bound, not inlined.
 */
function buildOwnershipQuery(rows: readonly OwnedRow[]): OwnershipQuery {
  const discriminatorParams: string[] = [];

  const clauses = rows.map((row) => {
    const conditions = [`"${row.idColumn}" = $1`, `"${row.ownerColumn}" = $2`];

    if (row.discriminator != null) {
      discriminatorParams.push(row.discriminator.value);
      conditions.push(`"${row.discriminator.column}" = $${2 + discriminatorParams.length}`);
    }

    return `EXISTS (SELECT 1 FROM "${row.schema}"."${row.table}" WHERE ${conditions.join(' AND ')})`;
  });

  return { sql: `SELECT (${clauses.join(' AND ')}) AS owned`, discriminatorParams };
}

/** A Map, not an object, so a type outside the list reads `undefined` rather than an `Object.prototype` key. */
export const TAGGABLE_ENTITY_OWNERSHIP_QUERIES: ReadonlyMap<TaggableEntity, OwnershipQuery> = new Map(
  TAGGABLE_ENTITIES.map((type) => [type, buildOwnershipQuery(TAGGABLE_ENTITY_OWNERSHIP[type])]),
);
