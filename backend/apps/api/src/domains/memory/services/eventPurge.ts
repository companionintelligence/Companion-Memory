import type { EntityManager } from 'typeorm';

/**
 * Tables that reference `ci.events` or `ci.content` with NO `ON DELETE` action, so
 * a row in any of them makes the delete of the event, or of a content row that
 * cascades from it, fail outright. {@link purgeEventAggregates} empties each one
 * first.
 *
 * Exported so a test can compare it with the live catalog: a new table that
 * references either with no action has to be listed here and cleared below, and
 * that test fails, naming the table, until it is. Without it the first anyone
 * would hear of such a table is a delete that fails on a real appliance, which
 * is how `memory.forget`'s `archive_and_delete` came to fail on the 98% of the
 * reference corpus's events that HBPE had clustered.
 */
export const EVENT_PURGE_BLOCKERS = [
  'hbpe.content_context',
  'hbpe.l1_event_cluster',
  'hbpe.l2_content_cluster',
] as const;

/** What one purge removed, for the caller to announce once the transaction has committed. */
export interface PurgedEventAggregates {
  /** The events that went, each with the start time HBPE needs to re-serialise that day. */
  events: Array<{ id: string; startTime: Date | null }>;
  /** The `Content` aggregates that hung off those events and went with them. */
  contentIds: string[];
}

/**
 * Permanently deletes events, and everything that has no meaning without them,
 * inside the caller's transaction.
 *
 * Deleting the `ci.entities` base row of an event is not enough, and used not to
 * be possible at all. It cascades to the `ci.events` detail row and to the event's
 * `ci.content` rows, and then three things go wrong:
 *
 *  1. **It fails.** HBPE's cluster-membership tables reference the event, and its
 *     content, with no `ON DELETE` action ({@link EVENT_PURGE_BLOCKERS}). HBPE
 *     clusters nearly every event, so the delete raised on nearly every event.
 *  2. **It strands the content's graph node.** The cascade removes the
 *     `ci.content` detail row, but the `Content` base row in `ci.entities` owns
 *     the content's title, and nothing cascades to it. A photo's title would live
 *     on as a node with no content behind it.
 *  3. **It leaves rows that point at nothing.** `ci.relationships` has no foreign
 *     key to `ci.entities`, and neither do the provenance ledger, the pipeline
 *     state, the tags and categories, the search index or the graph deltas. The
 *     deltas matter most: a node's `created` delta carries its title.
 *
 * So the steps run in dependency order: blockers, then everything that only
 * points at the event, then the content's base rows, then the events' own.
 * `ci.relationships` is cleaned in BOTH directions, which `memory.forget` never
 * did.
 *
 * What it deliberately leaves alone is every record that merely MENTIONS the
 * event, whose foreign key is `ON DELETE SET NULL`: receipts, object
 * observations, capture events, files, event candidates and a recurring series'
 * overrides. Those are records in their own right, and the schema already chose
 * what happens to them. A photo event's file is one: the content row only
 * links to it.
 *
 * It is not a tombstone. {@link CalendarEventService.remove} is what the app's
 * delete uses, and what `restore` can undo. This cannot be undone, and an event
 * that arrived from a source that syncs again will arrive again.
 *
 * Only the caller's own events are purged. An id that does not exist, or that
 * belongs to someone else, is left out of the result rather than raising.
 *
 * The teardown is the one migration 20260904035958, which re-keys the Reddit
 * connection records, already writes in SQL for its own doomed events. This is
 * the same list, run by the application.
 */
export async function purgeEventAggregates(
  manager: EntityManager,
  userId: string,
  requestedEventIds: string[],
): Promise<PurgedEventAggregates> {
  // Locked, and in a fixed order, so two purges cannot deadlock each other and
  // HBPE cannot assign a cluster to an event after this has cleared its rows.
  const events: Array<{ id: string; startTime: Date | null }> = await manager.query(
    `SELECT event_id AS id, start_time AS "startTime"
       FROM ci.events
      WHERE event_id = ANY($1::uuid[])
        AND user_id = $2
      ORDER BY event_id
        FOR UPDATE`,
    [requestedEventIds, userId],
  );

  if (events.length === 0) {
    return { events: [], contentIds: [] };
  }

  const eventIds = events.map((event) => event.id);

  // Whatever `ci.content.event_id` points at the events goes with them, whoever
  // owns the row: the foreign key cascades to it regardless, so leaving its base
  // row behind would only strand it.
  const content: Array<{ id: string }> = await manager.query(
    `SELECT id FROM ci.content WHERE event_id = ANY($1::uuid[]) ORDER BY id`,
    [eventIds],
  );
  const contentIds = content.map((row) => row.id);
  const everyId = [...eventIds, ...contentIds];

  const exec = (sql: string, ids: string[]) => manager.query(sql, [ids]);

  // 1. What blocks the delete. HBPE only ever increments a cluster's
  // `member_count`, and ranks each user's top-50 L1 vocabulary by it, so the
  // memberships deleted here are taken off the count in the same statement. A
  // cluster that loses its last member stays: it is HBPE's to retire.
  await exec(
    `WITH gone AS (
       DELETE FROM hbpe.l1_event_cluster WHERE event_id = ANY($1::uuid[]) RETURNING cluster_id
     ), per_cluster AS (
       SELECT cluster_id, count(*)::int AS members FROM gone GROUP BY cluster_id
     )
     UPDATE hbpe.l1_clusters c
        SET member_count = GREATEST(c.member_count - p.members, 0),
            updated_at = now()
       FROM per_cluster p
      WHERE c.cluster_id = p.cluster_id`,
    eventIds,
  );
  await exec(
    `WITH gone AS (
       DELETE FROM hbpe.l2_content_cluster WHERE content_id = ANY($1::uuid[]) RETURNING cluster_id
     ), per_cluster AS (
       SELECT cluster_id, count(*)::int AS members FROM gone GROUP BY cluster_id
     )
     UPDATE hbpe.l2_clusters c
        SET member_count = GREATEST(c.member_count - p.members, 0),
            updated_at = now()
       FROM per_cluster p
      WHERE c.cluster_id = p.cluster_id`,
    contentIds,
  );
  await exec('DELETE FROM hbpe.content_context WHERE content_id = ANY($1::uuid[])', contentIds);

  // 2. What only points at them, with no foreign key to say so.
  await exec(
    `DELETE FROM ci.relationships
      WHERE from_entity_id = ANY($1::uuid[]) OR to_entity_id = ANY($1::uuid[])`,
    everyId,
  );
  await exec(
    `DELETE FROM ci.record_sources
      WHERE (record_table = 'events' AND record_id = ANY($1::uuid[]))
         OR (record_table = 'content' AND record_id = ANY($1::uuid[]))`,
    everyId,
  );
  await exec('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])', everyId);
  await exec('DELETE FROM ci.pipeline_dead_letters WHERE entity_id = ANY($1::uuid[])', everyId);
  await exec('DELETE FROM ci.graph_deltas WHERE entity_id = ANY($1::uuid[])', everyId);

  // Raw SQL because this domain cannot import the search domains (they import
  // this one), as `GraphUtilityService.dropStalePersonIndex` and the merge
  // services do for their own `ci_search` rows. Done here rather than left to the
  // removal events below so that the index is clean when the transaction
  // commits, not whenever a queue gets round to it.
  await exec('DELETE FROM ci_search.entity_tag WHERE entity_id = ANY($1::uuid[])', everyId);
  await exec('DELETE FROM ci_search.entity_categories WHERE entity_id = ANY($1::uuid[])', everyId);
  await exec('DELETE FROM ci_search.vectors WHERE entity_id = ANY($1::uuid[])', everyId);
  await exec('DELETE FROM ci_search.embeddings WHERE entity_id = ANY($1::uuid[])', everyId);
  await exec('DELETE FROM ci_search.index_skips WHERE entity_id = ANY($1::uuid[])', everyId);

  // A sub-event's `parent_event_id` has no foreign key, so it would dangle. Make
  // it what `recurrence_parent_id` already does when its parent goes.
  await manager.query(
    `UPDATE ci.events
        SET parent_event_id = NULL,
            updated_at = now()
      WHERE parent_event_id = ANY($1::uuid[])
        AND NOT (event_id = ANY($1::uuid[]))`,
    [eventIds],
  );

  // 3. The aggregates themselves. The content's base rows first: they take the
  // `ci.content` detail rows with them, and nothing else would take them.
  await manager.query(
    `DELETE FROM ci.entities WHERE entity_type = 'Content' AND entity_id = ANY($1::uuid[])`,
    [contentIds],
  );
  await manager.query(`DELETE FROM ci.entities WHERE entity_type = 'Event' AND entity_id = ANY($1::uuid[])`, [
    eventIds,
  ]);

  return { events, contentIds };
}
