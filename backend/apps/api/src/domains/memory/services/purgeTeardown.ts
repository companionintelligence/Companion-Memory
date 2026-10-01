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
 * What a kind of node is called in the rows that name it by id and have no
 * foreign key to say so. Two of those tables key a row by something other than
 * the node's id alone, so {@link deleteBareReferences} has to be told which kind
 * it is clearing, and a caller cannot leave it out.
 */
export interface BareReferenceKind {
  /**
   * The `ci.record_sources.record_table` its provenance is ledgered under: the
   * name of its detail table, which is not always the name of the node
   * (`objects` for an item). Left out for a kind that nothing ledgers, which is
   * a stored file: no `appendRecordSources` caller names one.
   */
  ledgerTable?: 'events' | 'content' | 'communications' | 'objects';
  /**
   * The `ci.identifier_claims.subject_type` the person-link stages write its
   * participants' claims under. Only an event and a communication have
   * participants, and the claims are keyed by the subject's id, so they name it
   * with no foreign key and carry the very email addresses and phone numbers a
   * forget is meant to erase.
   */
  claimSubjectType?: 'event' | 'communication';
}

export const EVENT_REFERENCES: BareReferenceKind = { ledgerTable: 'events', claimSubjectType: 'event' };
export const CONTENT_REFERENCES: BareReferenceKind = { ledgerTable: 'content' };
export const COMMUNICATION_REFERENCES: BareReferenceKind = {
  ledgerTable: 'communications',
  claimSubjectType: 'communication',
};
export const ITEM_REFERENCES: BareReferenceKind = { ledgerTable: 'objects' };

/**
 * A stored file. Neither half of the kind applies: nothing ledgers a file, and a
 * file has no participants, so there is no ledger table and no claim subject to
 * name. What a file does have is several ids, and the rows that name it use all of
 * them: the pipeline, the search index and the tags are keyed by the id of its
 * `ci.files` row, the graph (edges, deltas) by the id of its `File` node, and the
 * search rows of its extracted text by the id of each chunk. The caller passes
 * every kind of id in the one list, and a uuid names one row wherever it is
 * looked for.
 */
export const FILE_REFERENCES: BareReferenceKind = {};

/**
 * Deletes every row that names one of these event, content, communication, item
 * or file ids and has no foreign key to say so, in the caller's transaction.
 *
 * `ci.relationships` has no foreign key to `ci.entities`, and neither do the
 * provenance ledger, the pipeline bookkeeping, the tags and categories, the
 * search index, the graph deltas or the identifier claims. Deleting the node
 * leaves each of them pointing at nothing, and the nightly orphan sweep only
 * reaches three of the search tables. The deltas matter most: a node's `created`
 * delta carries its title, and a `deleted` one its old name.
 *
 * `ci.relationships` is cleaned in BOTH directions, and the deltas that recorded
 * those edges go with them. A delta names an edge's endpoints and carries its
 * properties, so once the edge is deleted it describes something that no longer
 * exists. They are found by the relationship id the delete returns, which
 * `graph_deltas_relationship_idx` serves, and not by endpoint, which nothing
 * indexes: a scan of every delta ever written, once per forget.
 *
 * The ledger is cleaned for the one record table `kind` names, and the identifier
 * claims for the one subject type, so that a caller says what it is clearing and
 * cannot clear another kind's rows by accident. Raw SQL for the search tables
 * because this domain cannot import the search domains (they import this one), as
 * `GraphUtilityService.dropStalePersonIndex` and the merge services do for their
 * own `ci_search` rows. Done here, in the transaction, rather than left to the
 * removal events the caller announces afterwards, so the index is clean when the
 * transaction commits and not whenever a queue gets round to it.
 *
 * A pipeline stage that is mid-flight for one of these ids can still write a row
 * for it after this commits: none of these tables has a foreign key to hold it
 * off, and the nightly sweep reaches only three of them.
 */
export async function deleteBareReferences(
  manager: EntityManager,
  ids: string[],
  kind: BareReferenceKind,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const exec = (sql: string) => manager.query(sql, [ids]);

  await exec(
    `WITH gone AS (
       DELETE FROM ci.relationships
        WHERE from_entity_id = ANY($1::uuid[]) OR to_entity_id = ANY($1::uuid[])
       RETURNING relationship_id
     )
     DELETE FROM ci.graph_deltas
      WHERE relationship_id IN (SELECT relationship_id FROM gone)`,
  );
  if (kind.ledgerTable !== undefined) {
    await manager.query(
      `DELETE FROM ci.record_sources
        WHERE record_table = $2 AND record_id = ANY($1::uuid[])`,
      [ids, kind.ledgerTable],
    );
  }

  if (kind.claimSubjectType !== undefined) {
    await manager.query(
      `DELETE FROM ci.identifier_claims
        WHERE subject_type = $2 AND subject_id = ANY($1::uuid[])`,
      [ids, kind.claimSubjectType],
    );
  }

  await exec('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci.pipeline_dead_letters WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci.graph_deltas WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci_search.entity_tag WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci_search.entity_categories WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci_search.vectors WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci_search.embeddings WHERE entity_id = ANY($1::uuid[])');
  await exec('DELETE FROM ci_search.index_skips WHERE entity_id = ANY($1::uuid[])');
}
