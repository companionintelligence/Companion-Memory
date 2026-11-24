import type { EntityManager } from 'typeorm';

import { teardownContent } from './contentPurge';
import { clearHbpeLinks, deleteBareReferences, EVENT_REFERENCES } from './purgeTeardown';
import {
  deleteWrappedFileObjects,
  deleteWrappedFileRows,
  nothingWrapped,
  planWrappedFiles,
  type WrappedFilesPurged,
  type WrappedFileStorage,
} from './wrappedFilePurge';

/** What one purge removed, for the caller to announce once the transaction has committed. */
export interface PurgedEventAggregates {
  /** The events that went, each with the start time HBPE needs to re-serialise that day. */
  events: Array<{ id: string; startTime: Date | null }>;
  /** The `Content` aggregates that hung off those events and went with them. */
  contentIds: string[];
  /** What was done about the stored files that content wrapped, and the ones linked straight to the events. */
  files: WrappedFilesPurged;
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
 *     content, with no `ON DELETE` action ({@link clearHbpeLinks}). HBPE clusters
 *     nearly every event, so the delete raised on nearly every event.
 *  2. **It strands the content's graph node.** The cascade removes the
 *     `ci.content` detail row, but the `Content` base row in `ci.entities` owns
 *     the content's title, and nothing cascades to it. A photo's title would live
 *     on as a node with no content behind it.
 *  3. **It leaves rows that point at nothing.** `ci.relationships` has no foreign
 *     key to `ci.entities`, and neither do the provenance ledger, the pipeline
 *     state, the tags and categories, the search index, the graph deltas or the
 *     identifier claims, which are the organizer's and the participants' raw
 *     addresses. The deltas matter most: a node's `created` delta carries its title.
 *
 * So the steps run in dependency order: the links that block the delete, then
 * everything that only points at the event, then the content ({@link teardownContent}),
 * then the events' own base rows. `ci.relationships` is cleaned in BOTH
 * directions, which `memory.forget` never did.
 *
 * What it deliberately leaves alone is every record that merely MENTIONS the
 * event, whose foreign key is `ON DELETE SET NULL`: receipts, object
 * observations, capture events, event candidates and a recurring series'
 * overrides. Those are records in their own right, and the schema already chose
 * what happens to them.
 *
 * A stored file is not one of them. A photo event's photo is a file that its
 * content row wraps, and a capture screenshot is a file linked to the event
 * itself (`ci.files.event_id`, which would be nulled and the file kept). Both are
 * the event's, so they go with it, with their previews and their bytes, when
 * nothing else uses them, and stay, reported in the result, when something does:
 * a message that attached the same photo, say ({@link planWrappedFiles}). They
 * are decided and have their objects deleted before any row is, and a failure
 * after that leaves rows that still say where the bytes were, this event's
 * among them.
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
  storage?: WrappedFileStorage,
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
    return { events: [], contentIds: [], files: nothingWrapped() };
  }

  const eventIds = events.map((event) => event.id);

  // Whatever `ci.content.event_id` points at the events goes with them, whoever
  // owns the row: the foreign key cascades to it regardless, so leaving its base
  // row behind would only strand it. HBPE labels content too, so it is locked
  // before its links are cleared, which `teardownContent` sees to.
  const content: Array<{ id: string; eventId: string }> = await manager.query(
    `SELECT id, event_id AS "eventId" FROM ci.content WHERE event_id = ANY($1::uuid[]) ORDER BY id`,
    [eventIds],
  );
  const contentIds = content.map((row) => row.id);

  // The photos these events own are locked, decided and have their objects deleted before anything
  // is touched. Each content row is named by its event: that is what a caller is told to forget
  // again if the purge fails once the bytes are gone. The files come before the content in lock
  // order, as they do in the purge of content on its own.
  const plan = await planWrappedFiles(manager, userId, {
    content: content.map((row) => ({ id: row.id, named: row.eventId })),
    eventIds,
    messageIds: [],
  });
  const stored = await deleteWrappedFileObjects(manager, plan, storage);

  // 1. What blocks the delete, and what only points at the events, with no
  // foreign key to say so.
  await clearHbpeLinks(manager, 'ci.events', eventIds);
  await deleteBareReferences(manager, eventIds, EVENT_REFERENCES);

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

  // 2. The content, whole. Its base rows go before the events', which would
  // cascade to the detail rows and strand them.
  await teardownContent(manager, contentIds);

  // 3. The events themselves.
  await manager.query(`DELETE FROM ci.entities WHERE entity_type = 'Event' AND entity_id = ANY($1::uuid[])`, [
    eventIds,
  ]);

  // 4. The files that nothing uses now. Last, so that the content that wrapped them and the events that
  // they were linked to, which the foreign key would have nulled, are gone first.
  const files = await deleteWrappedFileRows(manager, userId, plan, stored);

  return { events, contentIds, files };
}
