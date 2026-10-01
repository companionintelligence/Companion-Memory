import type { EntityManager } from 'typeorm';

/**
 * An HBPE table that holds one row per event or content item, with a foreign key
 * to it and NO `ON DELETE` action. HBPE labels nearly everything it sees, so most
 * events and most content have a row in each, and Postgres refuses to delete the
 * row they reference.
 */
export interface HbpeLink {
  /** The HBPE table. */
  table: string;
  /** Its column that holds the id. */
  column: string;
  /** The table that column references. */
  references: 'ci.events' | 'ci.content';
  /**
   * The cluster table whose `member_count` counts these rows. HBPE only ever
   * increments that count, and ranks each user's top-50 vocabulary by it, so a
   * membership that is deleted is taken off the count in the same statement.
   */
  clusters?: string;
}

/**
 * Every HBPE table that can stop an event or a content row being deleted, and
 * so everything {@link clearHbpeLinks} clears.
 *
 * This list is the whole definition of that: the statements are built from it,
 * so a table cannot be listed here and not cleared. And the catalog guard
 * (`purgeTeardown.catalog.integration.spec.ts`) holds it against the live
 * catalog, so a table that references either with no `ON DELETE` action and is
 * not listed fails that test, by name, rather than failing a delete on a real
 * appliance. That is how `memory.forget`'s `archive_and_delete` came to fail on
 * the 98% of the reference corpus's events that HBPE had clustered, and on every
 * clustered content row after it.
 */
export const HBPE_LINKS: readonly HbpeLink[] = [
  {
    table: 'hbpe.l1_event_cluster',
    column: 'event_id',
    references: 'ci.events',
    clusters: 'hbpe.l1_clusters',
  },
  {
    table: 'hbpe.l2_content_cluster',
    column: 'content_id',
    references: 'ci.content',
    clusters: 'hbpe.l2_clusters',
  },
  { table: 'hbpe.content_context', column: 'content_id', references: 'ci.content' },
];

/** The primary key of each table an {@link HbpeLink} can reference. */
const REFERENCED_KEY: Record<HbpeLink['references'], string> = {
  'ci.events': 'event_id',
  'ci.content': 'id',
};

/**
 * Deletes HBPE's rows for these events, or for this content, so that deleting
 * the rows themselves is no longer refused. Runs in the caller's transaction.
 *
 * It locks the rows first, in key order, and that is the point of doing it here
 * rather than in each caller. HBPE inserts a link with a key-share lock on the
 * row it references, which conflicts with this lock, so HBPE has either
 * committed already, and the delete below sees its row, or it waits until this
 * transaction ends, by which time the row is gone and its insert fails. Without
 * the lock a link committed between this delete and the delete of the row it
 * references would stop that delete after all, on exactly the rows this was
 * meant to free.
 *
 * Only the links are cleared. The clusters are HBPE's: a cluster that loses its
 * last member stays, for HBPE to retire.
 */
export async function clearHbpeLinks(
  manager: EntityManager,
  references: HbpeLink['references'],
  ids: string[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const key = REFERENCED_KEY[references];

  await manager.query(
    `SELECT ${key} FROM ${references} WHERE ${key} = ANY($1::uuid[]) ORDER BY ${key} FOR UPDATE`,
    [ids],
  );

  for (const link of HBPE_LINKS) {
    if (link.references !== references) {
      continue;
    }

    if (link.clusters === undefined) {
      await manager.query(`DELETE FROM ${link.table} WHERE ${link.column} = ANY($1::uuid[])`, [ids]);

      continue;
    }

    await manager.query(
      `WITH gone AS (
         DELETE FROM ${link.table} WHERE ${link.column} = ANY($1::uuid[]) RETURNING cluster_id
       ), per_cluster AS (
         SELECT cluster_id, count(*)::int AS members FROM gone GROUP BY cluster_id
       )
       UPDATE ${link.clusters} c
          SET member_count = GREATEST(c.member_count - p.members, 0),
              updated_at = now()
         FROM per_cluster p
        WHERE c.cluster_id = p.cluster_id`,
      [ids],
    );
  }
}

/**
 * Deletes every row that names one of these event or content ids and has no
 * foreign key to say so, in the caller's transaction.
 *
 * `ci.relationships` has no foreign key to `ci.entities`, and neither do the
 * provenance ledger, the pipeline bookkeeping, the tags and categories, the
 * search index or the graph deltas. Deleting the node leaves each of them
 * pointing at nothing, and the nightly orphan sweep only reaches three of the
 * search tables. The deltas matter most: a node's `created` delta carries its
 * title, and a `deleted` one its old name.
 *
 * `ci.relationships` is cleaned in BOTH directions.
 *
 * The ledger is cleaned for the two record tables the callers purge, `events`
 * and `content`. Raw SQL for the search tables because this domain cannot import
 * the search domains (they import this one), as
 * `GraphUtilityService.dropStalePersonIndex` and the merge services do for their
 * own `ci_search` rows. Done here, in the transaction, rather than left to the
 * removal events the caller announces afterwards, so the index is clean when the
 * transaction commits and not whenever a queue gets round to it.
 */
export async function deleteBareReferences(manager: EntityManager, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const exec = (sql: string) => manager.query(sql, [ids]);

  await exec(
    `DELETE FROM ci.relationships
      WHERE from_entity_id = ANY($1::uuid[]) OR to_entity_id = ANY($1::uuid[])`,
  );
  await exec(
    `DELETE FROM ci.record_sources
      WHERE record_table IN ('events', 'content') AND record_id = ANY($1::uuid[])`,
  );
  await exec('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci.pipeline_dead_letters WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci.graph_deltas WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci_search.entity_tag WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci_search.entity_categories WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci_search.vectors WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci_search.embeddings WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci_search.index_skips WHERE entity_id = ANY($1::uuid[])');
}
