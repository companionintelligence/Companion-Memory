import type { EntityManager } from 'typeorm';

import { clearHbpeLinks, CONTENT_REFERENCES, deleteBareReferences } from './purgeTeardown';
import {
  deleteWrappedFileRows,
  planWrappedFiles,
  queueWrappedFileObjects,
  type WrappedFilePlan,
  type WrappedFilesPurged,
  type WrappedFileStorage,
} from './wrappedFilePurge';

/**
 * Permanently deletes these content rows, and everything that has no meaning
 * without them, inside the caller's transaction. It locks the rows before it
 * clears anything, which {@link clearHbpeLinks} does, so HBPE cannot label one
 * after its links have been cleared.
 *
 * This is the half of a purge that is the same whether the content is the
 * target or only hangs off one. Deleting the `Content` base row in
 * `ci.entities` is not enough on its own, and used not to be possible at all:
 * it cascades to the `ci.content` detail row, and then
 *
 *  1. **It fails.** HBPE's `l2_content_cluster` and `content_context` reference
 *     the row with no `ON DELETE` action ({@link clearHbpeLinks}), and HBPE
 *     labels nearly all content, so the delete raised for nearly all of it.
 *  2. **It leaves rows that point at nothing**, which nothing else would delete
 *     ({@link deleteBareReferences}).
 *
 * The steps run in dependency order: the links that block the delete, then
 * everything that only points at the content, then the content itself.
 *
 * What it deliberately leaves alone is every record that merely MENTIONS the
 * content: a receipt's `document_content_id`, an object observation's
 * `content_id` and `crop_content_id`, a product model's `image_content_id`.
 * Those are records in their own right, and their schema chose what happens to
 * them: no foreign key, because "content and files are purgeable, so a hard FK
 * would block a purge or resurrect a dead pointer".
 */
export async function teardownContent(manager: EntityManager, contentIds: string[]): Promise<void> {
  if (contentIds.length === 0) {
    return;
  }

  await clearHbpeLinks(manager, 'ci.content', contentIds);
  await deleteBareReferences(manager, contentIds, CONTENT_REFERENCES);
  await manager.query(
    `DELETE FROM ci.entities WHERE entity_type = 'Content' AND entity_id = ANY($1::uuid[])`,
    [contentIds],
  );
}

/** What one purge of content removed, for the caller to announce once the transaction has committed. */
export interface PurgedContentAggregates {
  /** The content rows that went. */
  contentIds: string[];
  /** What was done about the stored files those rows wrapped. */
  files: WrappedFilesPurged;
  /**
   * The `ci.stored_object_deletions` rows the purge queued: the stored objects of the files that went, to
   * delete once the transaction has committed (`drainStoredObjectDeletes`).
   */
  queuedObjectIds: string[];
}

/**
 * Permanently deletes content: the `Content` node, its `ci.content` row, and
 * everything that points at either. The content half of what
 * {@link purgeEventAggregates} does for an event's attached content, for content
 * that is the target itself.
 *
 * It is not {@link ContentService.remove}. That is the app's delete: it writes a
 * `deleted` graph delta, which carries the title, and keeps the node's earlier
 * deltas. This is `memory.forget`'s `archive_and_delete`: a node's deltas are
 * deleted with it and none is written, and the pipeline state, tags and search
 * rows of the content go in the transaction too. Both take the edges, the ledger
 * rows and the stored file the content wraps ({@link purgeFilesWrappedBy}).
 *
 * A photo is two rows, and the bytes are the part that is the photo: the content row
 * wraps a `ci.files` row through `external_id`. That file goes with the content when
 * nothing else uses it, and stays, reported in the result, when something does
 * ({@link planWrappedFiles}). Its objects are QUEUED in this transaction and deleted by
 * the caller after the commit ({@link purgeFilesWrappedBy}), so a failure anywhere here
 * rolls the rows back with the bytes untouched.
 *
 * Only the caller's own content is purged. An id that does not exist, or that
 * belongs to someone else, is left out of the result rather than raising. So is
 * a `Content` node with no `ci.content` row behind it, which graph ingest can
 * write: there is nothing here for HBPE to have clustered, and the generic node
 * delete has nothing to cascade.
 *
 * Content attached to an event is purged like any other, and the event is left
 * alone. Purging the event is what takes its content with it.
 *
 * @param storage the object store, for the stored files this deletes. Without one, a purge
 *   that would have to delete stored bytes is refused before anything is changed.
 * @returns the ids that were purged and what was done about the files they wrapped, for the
 *   caller to announce once the transaction has committed.
 */
export async function purgeContentAggregates(
  manager: EntityManager,
  userId: string,
  requestedContentIds: string[],
  storage?: WrappedFileStorage,
): Promise<PurgedContentAggregates> {
  // Whose a row is, `user_id` says, as it does for events. The lock is not taken
  // here but by `teardownContent`, in key order, as the first thing it does to
  // them: it is what has to come before the links are cleared, and nothing else
  // here needs the rows held any earlier.
  const content: Array<{ id: string }> = await manager.query(
    `SELECT id
       FROM ci.content
      WHERE id = ANY($1::uuid[])
        AND user_id = $2
      ORDER BY id`,
    [requestedContentIds, userId],
  );
  const contentIds = content.map((row) => row.id);
  const { files, queuedObjectIds } = await purgeFilesWrappedBy(manager, userId, contentIds, storage, () =>
    teardownContent(manager, contentIds),
  );

  return { contentIds, files, queuedObjectIds };
}

/**
 * Deletes the stored files these content rows wrap, when nothing else uses them, around the caller's
 * own teardown of the content, in the caller's transaction. The one sequence both deletes of content
 * run, so that they agree on what goes: `memory.forget`'s purge ({@link purgeContentAggregates}) and
 * the app's delete (`ContentService.remove`, which the Explorer drawer calls).
 *
 * The files are locked and decided ({@link planWrappedFiles}) before `teardown` touches the content,
 * which is given the plan (`plan.wrapping` says which content rows are file-backed). The files come
 * before the content in lock order, here and in the event's purge, so that two purges that share a file
 * cannot wait on each other. Then the file rows go with every row that names them: the `File` nodes,
 * their edges and deltas, the pipeline state, the tags, categories and search rows keyed by the file,
 * its chunks or its node ({@link deleteWrappedFileRows}).
 *
 * **The bytes are not deleted here.** Their objects are queued in `ci.stored_object_deletions`, in this
 * transaction, and the caller deletes them after it commits (`drainStoredObjectDeletes`, given
 * `queuedObjectIds`). Deleting them in the transaction, as this used to, lost bytes whenever anything
 * after that failed: the teardown, the row deletes or the commit rolled the rows back, and the bytes
 * stayed gone. Now a rollback takes the queue rows back too and never touches a byte, and a commit
 * whose store delete fails, times out or half succeeds leaves queue rows the sweep retries. The
 * no-store refusal still comes before anything is changed.
 *
 * Only `userId`'s own files are taken, whoever's content names them, and the caller is expected to
 * have already scoped `contentIds` to that user.
 */
export async function purgeFilesWrappedBy(
  manager: EntityManager,
  userId: string,
  contentIds: string[],
  storage: WrappedFileStorage | undefined,
  teardown: (plan: WrappedFilePlan) => Promise<void>,
): Promise<{ files: WrappedFilesPurged; queuedObjectIds: string[] }> {
  const plan = await planWrappedFiles(manager, userId, {
    content: contentIds.map((id) => ({ id, named: id })),
    eventIds: [],
    messageIds: [],
  });
  const queued = await queueWrappedFileObjects(manager, plan, storage);

  await teardown(plan);

  const files = await deleteWrappedFileRows(manager, userId, plan, queued);

  return { files, queuedObjectIds: queued.ids };
}
