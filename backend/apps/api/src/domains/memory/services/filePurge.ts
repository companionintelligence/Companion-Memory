import type { EntityManager } from 'typeorm';

import { deleteBareReferences, FILE_REFERENCES } from './purgeTeardown';

/**
 * The part of the object store a purge needs. The files domain's
 * `FileService.deleteObjects` is the one implementation: S3's batch delete, which
 * succeeds for a key that is already gone.
 */
export interface StoredObjects {
  deleteObjects(bucket: string, keys: string[]): Promise<void>;
}

/**
 * The injection token `ContentService` and `CalendarEventService` take the object store under. They purge
 * the stored files that content and events wrap ({@link planWrappedFiles}), so they need the same
 * {@link StoredObjects} the files purge uses, and take it by this token rather than by the files
 * domain's class: that keeps that domain's whole barrel out of two services that are loaded all over.
 * Optional, because a service built without it can still purge everything that wraps no stored object.
 */
export const STORED_OBJECTS = Symbol('STORED_OBJECTS');

/**
 * How long a purge waits for the object store while it holds its row locks.
 * Nothing else bounds it: the S3 client sets no timeout, and neither the database
 * (`idle_in_transaction_session_timeout` is 0) nor the tool framework ends a
 * transaction that is sitting idle on a hung connection.
 */
export const STORED_OBJECT_DELETE_DEADLINE_MS = 60_000;

/** How many times the variants of a file may change under the purge before it gives up. */
const MAX_LOCK_ATTEMPTS = 3;

/** What one purge removed, for the caller to announce once the transaction has committed. */
export interface PurgedFiles {
  /** The `File` nodes that went: the ones the caller named, and any that shadowed a variant of one of those files. */
  nodeIds: string[];
  /** Every `ci.files` row that went: the files the named nodes stand for, and every variant under them. */
  fileIds: string[];
  /** The variants among `fileIds` that no named node stood for: copies nobody asked about. */
  copyFileIds: string[];
  /** How many stored objects were deleted from the object store. */
  deletedObjects: number;
  /** How many stayed, because a `ci.files` row outside this purge names the same object. */
  keptObjects: number;
  /**
   * Content rows that wrap one of these files and were left alone. An imported photo is two
   * rows, and the content one is what the user sees: it keeps the filename and the image
   * describer's text, and is the caller's to forget separately.
   */
  wrappingContentIds: string[];
}

export function nothingPurged(): PurgedFiles {
  return {
    nodeIds: [],
    fileIds: [],
    copyFileIds: [],
    deletedObjects: 0,
    keptObjects: 0,
    wrappingContentIds: [],
  };
}

/**
 * The stored objects of these files are gone and their records are not.
 *
 * A purge deletes the objects before the rows, so a failure between the two leaves
 * exactly this: a file the app still lists whose contents will not open. Forgetting
 * the file again repairs it: the same rows are found, the objects are deleted again
 * (the object store counts a key that is already gone as deleted) and then the rows.
 * The keys are the reason the rows must outlive the objects: a purge that deleted
 * the rows first would lose the only record of what to delete.
 */
export class StoredObjectsDeletedError extends Error {
  constructor(
    /**
     * What the caller named whose files lost their stored objects, and which is still there: the `File`
     * nodes, for a purge of files, and for a purge of content or of an event, the content or the events,
     * which still wrap a photo that no longer opens. Forgetting them again finishes the job.
     */
    readonly nodeIds: string[],
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    super(`The stored objects were deleted but their records could not be: ${reason}`, { cause });
    this.name = 'StoredObjectsDeletedError';
  }
}

export interface PurgeFileOptions {
  /** Overrides {@link STORED_OBJECT_DELETE_DEADLINE_MS}. */
  deadlineMs?: number;
  /**
   * Called once the objects are deleted and before anything else is, with the ids the caller named
   * whose files lost them: `File` nodes for a purge of files, and for a purge of what wraps a file
   * ({@link planWrappedFiles}) the content or the events. Whatever fails after this leaves
   * {@link StoredObjectsDeletedError}'s state, and the caller is the one placed to say so, because
   * the commit itself can fail too.
   */
  onObjectsDeleted?: (namedIds: string[]) => void;
}

export interface LockedFile {
  id: string;
  bucket: string | null;
  key: string | null;
  /** The file this is a variant of, when it is one. */
  parentId: string | null;
  /** The event it is linked to directly (`ci.files.event_id`), which is how a capture screenshot is. */
  eventId: string | null;
}

/** Where a purge starts from: the files it was asked to delete, named one of two ways. */
export interface FileRoots {
  /** `File` nodes. Each stands for the `ci.files` row its `linked_id` names. */
  nodeIds?: string[];
  /**
   * `ci.files` rows by their own id: for a caller that reached a file through something that wraps it,
   * a content row or an event, and so has no node to name. A file whose node was never written (graph
   * presence is written by a listener, after the upload) is still a file.
   */
  fileIds?: string[];
}

/**
 * Each named file's stored row and every variant under it (previews, thumbnails, playback copies, to
 * any depth), locked in key order in one statement. A file is named by its `File` node, or by its own id.
 *
 * Only the caller's own: the node and its file must both be theirs, and so must every variant.
 * Variants are written under their original's owner (`FileService.create` takes the caller's
 * context), so a variant that is not the owner's is a row that should not exist. The purge neither
 * locks it nor deletes its object, because that object is not the caller's to destroy, though the
 * foreign key still removes the row with its parent.
 *
 * One statement, so that two purges lock in the same global order and cannot wait on each other. It
 * is the lock that matters more than the read. A variant is written with a foreign key to its parent,
 * which takes a key-share lock on the parent row, and that conflicts with this lock: a preview that
 * is being written when the purge starts has either committed already, and is found below, or waits
 * until the purge ends, by which time its parent is gone and the insert fails. Without the lock a
 * variant written after the objects are listed would be deleted by the cascade and leave its object
 * behind.
 *
 * The tree is worked out before the first lock is held, so it is worked out again afterwards. A
 * variant that was committed while the lock was being waited for is in the second answer and not the
 * first, and the statement runs again with it.
 */
export async function lockFiles(
  manager: EntityManager,
  userId: string,
  roots: FileRoots,
): Promise<LockedFile[]> {
  const nodeIds = roots.nodeIds ?? [];
  const fileIds = roots.fileIds ?? [];

  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    const locked: LockedFile[] = await manager.query(
      `WITH RECURSIVE tree AS (
         SELECT f.id
           FROM ci.entities e
           JOIN ci.files f ON f.id = e.linked_id
          WHERE e.entity_id = ANY($1::uuid[])
            AND e.entity_type = 'File'
            AND e.linked_table = 'files'
            AND e.owner_user_id = $2
            AND f.user_id = $2
         UNION
         SELECT f.id
           FROM ci.files f
          WHERE f.id = ANY($3::uuid[])
            AND f.user_id = $2
         UNION
         SELECT c.id
           FROM ci.files c
           JOIN tree t ON c.parent_id = t.id
          WHERE c.user_id = $2
       )
       SELECT f.id, f.bucket, f.key, f.parent_id AS "parentId", f.event_id AS "eventId"
         FROM ci.files f
        WHERE f.id IN (SELECT id FROM tree)
        ORDER BY f.id
          FOR UPDATE`,
      [nodeIds, userId, fileIds],
    );

    if (locked.length === 0) {
      return [];
    }

    const appeared: Array<{ id: string }> = await manager.query(
      `WITH RECURSIVE tree AS (
         SELECT id FROM ci.files WHERE id = ANY($1::uuid[])
         UNION
         SELECT c.id
           FROM ci.files c
           JOIN tree t ON c.parent_id = t.id
          WHERE c.user_id = $2
       )
       SELECT id FROM tree WHERE id <> ALL($1::uuid[])`,
      [locked.map((file) => file.id), userId],
    );

    if (appeared.length === 0) {
      return locked;
    }
  }

  throw new Error('Files kept appearing under the ones being deleted, so nothing was deleted. Try again.');
}

/**
 * The objects to delete, by bucket: the object of every locked file that has one, less any that a
 * `ci.files` row outside the purge also names.
 *
 * Every row is written with a fresh random key, so one object is one row, except where data came in
 * by another road. The account purge guards the same way and for the same reason: deleting an object
 * out from under another row is a data-loss bug caused by a privacy feature. A file that came from a
 * source with an `external_id` has no bucket and no key, because its bytes were never stored here.
 *
 * There is no index on `key` alone. PostgreSQL 18 serves the probe from `files_user_id_key_idx` by
 * skipping over its leading column, which costs one index search per user: 0.1 ms with one user and
 * 43 ms with 2,000, at 500,000 rows.
 */
async function objectsToDelete(
  manager: EntityManager,
  files: LockedFile[],
): Promise<{ byBucket: Map<string, string[]>; deleted: number; kept: number }> {
  const stored = files.filter(
    (file): file is LockedFile & { bucket: string; key: string } => file.bucket !== null && file.key !== null,
  );
  const byBucket = new Map<string, string[]>();

  if (stored.length === 0) {
    return { byBucket, deleted: 0, kept: 0 };
  }

  const named = (bucket: string | null, key: string): string => `${bucket ?? ''}/${key}`;
  const shared: Array<{ bucket: string | null; key: string }> = await manager.query(
    `SELECT bucket, key
       FROM ci.files
      WHERE key = ANY($1::uuid[])
        AND id <> ALL($2::uuid[])`,
    [stored.map((file) => file.key), files.map((file) => file.id)],
  );
  const keep = new Set(shared.map((row) => named(row.bucket, row.key)));
  const seen = new Set<string>();
  let kept = 0;

  for (const file of stored) {
    const object = named(file.bucket, file.key);

    if (seen.has(object)) {
      continue;
    }

    seen.add(object);

    if (keep.has(object)) {
      kept += 1;

      continue;
    }

    byBucket.set(file.bucket, [...(byBucket.get(file.bucket) ?? []), file.key]);
  }

  return { byBucket, deleted: seen.size - kept, kept };
}

/** Rejects if `work` has not settled within `ms`. The work itself is not cancelled. */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
  });

  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Deletes the stored objects of these locked files, and says how many went and how many stayed because a
 * `ci.files` row outside the set also names them ({@link objectsToDelete}). This is the part of a purge that
 * is not the database's, so the wait is bounded ({@link STORED_OBJECT_DELETE_DEADLINE_MS}), and a failure
 * says that nothing was deleted from the database, which is true: the rows are still there and still locked.
 *
 * Called with every row in place. `objects` is only needed when something stored is to be deleted: files
 * that came from a source with an `external_id` have no bytes here, and purging only those needs no
 * store. When there is something to delete and no store, that is refused before anything is touched.
 */
export async function deleteStoredObjects(
  manager: EntityManager,
  files: LockedFile[],
  objects: StoredObjects | undefined,
  deadlineMs: number = STORED_OBJECT_DELETE_DEADLINE_MS,
): Promise<{ deleted: number; kept: number }> {
  const stored = await objectsToDelete(manager, files);

  if (stored.byBucket.size === 0) {
    return { deleted: stored.deleted, kept: stored.kept };
  }

  if (objects === undefined) {
    throw new Error(
      'The stored objects could not be deleted, so nothing was deleted from the database: no object store is configured for this service.',
    );
  }

  try {
    await withDeadline(
      (async () => {
        for (const [bucket, keys] of stored.byBucket) {
          await objects.deleteObjects(bucket, keys.sort());
        }
      })(),
      deadlineMs,
      'The object store',
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    // Nothing in the database has been touched. Some objects may already be gone, if the store
    // failed halfway; deleting again is safe, and is the repair.
    throw new Error(
      `The stored objects could not be deleted, so nothing was deleted from the database (some may already be gone, and forgetting again is safe): ${reason}`,
      { cause },
    );
  }

  return { deleted: stored.deleted, kept: stored.kept };
}

/** The `File` nodes that shadow some files, and the chunks of their extracted text. */
export interface FileTrail {
  nodes: Array<{ entity_id: string; linked_id: string }>;
  chunkIds: string[];
}

/**
 * Reads what the rows of these files leave to be deleted along with them, which the rows themselves
 * do not say: the nodes that shadow them, which nothing joins to them by a foreign key, and the chunks
 * of their text, whose search rows are keyed by the chunk's own id.
 *
 * The extracted text goes with its file by cascade, and the search index holds two rows for each chunk,
 * keyed by the chunk's own id: the words of the document, and an embedding of them
 * (`FileChunkSearchIndexListener`). They are read here, while the chunks still exist, and cleared with
 * the rest. The files are locked, so a parse that is writing more chunks waits and then fails on the
 * foreign key, and cannot add one this misses.
 */
export async function readFileTrail(
  manager: EntityManager,
  userId: string,
  fileIds: string[],
): Promise<FileTrail> {
  const nodes: Array<{ entity_id: string; linked_id: string }> = await manager.query(
    `SELECT entity_id, linked_id
       FROM ci.entities
      WHERE entity_type = 'File'
        AND linked_table = 'files'
        AND linked_id = ANY($1::uuid[])
        AND owner_user_id = $2
      ORDER BY entity_id`,
    [fileIds, userId],
  );
  const chunks: Array<{ id: string }> = await manager.query(
    `SELECT id
       FROM ci.file_chunks
      WHERE file_id = ANY($1::uuid[])
      ORDER BY id`,
    [fileIds],
  );

  return { nodes, chunkIds: chunks.map((chunk) => chunk.id) };
}

/**
 * Deletes every row that names these files and has no foreign key to say so ({@link deleteBareReferences},
 * by the ids of the nodes, the files and the chunks together), then the `File` nodes, then the `ci.files`
 * rows. The variants, the chunks and the chat attachment links go by cascade, and an unfurl's poster pointer
 * is nulled.
 *
 * Called after the objects are gone ({@link deleteStoredObjects}), in the same transaction.
 */
export async function deleteFileRows(
  manager: EntityManager,
  userId: string,
  fileIds: string[],
  trail: FileTrail,
): Promise<void> {
  const nodeIds = trail.nodes.map((node) => node.entity_id);

  await deleteBareReferences(manager, [...nodeIds, ...fileIds, ...trail.chunkIds], FILE_REFERENCES);
  await manager.query(
    `DELETE FROM ci.entities
      WHERE entity_type = 'File' AND entity_id = ANY($1::uuid[]) AND owner_user_id = $2`,
    [nodeIds, userId],
  );
  await manager.query('DELETE FROM ci.files WHERE id = ANY($1::uuid[])', [fileIds]);
}

/**
 * Permanently deletes stored files, and everything that has no meaning without them, inside the
 * caller's transaction. This is `memory.forget`'s `archive_and_delete` for a `File` node.
 *
 * A `File` node is only the graph's shadow of a stored file. `FileService` writes it with
 * `linked_table = 'files'` and `linked_id` = the id of the `ci.files` row, and that is a plain
 * column: there is no foreign key between the two, in either direction. So deleting the node, which
 * is all the generic delete does, deletes the shadow and never reaches the file. Measured on a real
 * database, what it leaves is the `ci.files` row, its variants and their own `File` nodes, the
 * extracted chunks, the chat attachment links, the pipeline's state and dead letters, every search
 * row and tag (all keyed by the id of the `ci.files` row, not the node's), the search rows of the
 * chunks (keyed by each chunk's own id, and made of the document's words), and the stored bytes,
 * which nothing in the application deletes: `FileService.deleteObjects` was written for the account
 * purge and is the one thing that does. Nothing in the files domain deletes a file either, so this
 * is the first path that deletes one for a single user.
 *
 * What it does, in one transaction:
 *
 *  1. **Finds and locks the files** ({@link lockFiles}): the stored file of each named node and every
 *     variant under it, `FOR UPDATE`, in key order.
 *  2. **Deletes the stored objects** ({@link objectsToDelete}), while the locks are held, and
 *     BEFORE anything is deleted from the database.
 *  3. **Deletes everything that names the files** ({@link deleteBareReferences}), by the ids of the
 *     nodes and of the files together, then the nodes, then the `ci.files` rows. The variants, the
 *     chunks and the chat attachment links go by cascade, and an unfurl's poster pointer is nulled.
 *
 * **Why the bytes go first.** The objects cannot be in the same transaction as the rows, so one of
 * them has to go first, and the failure each order leaves is the whole decision:
 *
 *  - Objects first, as here. If the object store fails, the transaction rolls back and nothing was
 *    deleted. If the database fails afterwards, the bytes are gone and the rows are not: a file the
 *    app lists that will not open ({@link StoredObjectsDeletedError}). Forgetting it again finishes
 *    the job, because the keys are still in the rows.
 *  - Rows first. If the object store then fails, no row names the bytes any more, so nothing can
 *    retry and nothing knows they are there. The file was asked to be erased and stays in the bucket.
 *
 * This is the order the account purge uses, for the same reason. `FileService.create` goes the other
 * way, bytes before the row, because there the worse leftover is a row that claims bytes nobody holds:
 * it carries the content hash, so a re-upload of the same bytes is "deduplicated" onto a file that is
 * not there. The cost of the order chosen here is that same leftover, for as long as it takes to
 * forget the file again. It is accepted because the alternative leftover cannot be found again at
 * all, and erasing is what was asked for.
 *
 * The object store is called while the locks are held, so the call is bounded by a deadline. A
 * request that outlives it is abandoned, not cancelled, and can finish later: that is the same state
 * as the database failing after the objects went, and the same repair.
 *
 * What it deliberately leaves alone is every record that merely MENTIONS the file, which are records
 * in their own right: observations that name it (`ci.object_observations.file_id`), receipts it
 * was read from (`ci.receipts.source_file_id`), period summaries that list it
 * (`ci.summaries.related_files_ids`), the `attachments` of an imported message, and the content
 * rows that wrap it. None has a foreign key. The last are the ones that matter to the user: an
 * imported photo is a file and a `media` content row whose `external_id` is the file's id, and the
 * content row keeps the filename and the description the image describer wrote, so forgetting the
 * file does not forget what was in the photo. They are reported
 * ({@link PurgedFiles.wrappingContentIds}), and forgetting one is a call of its own.
 *
 * The other direction, forgetting the content or the event that wraps a file, is {@link planWrappedFiles}:
 * there the file is deleted when nothing else uses it, and kept, and reported, when something does.
 *
 * Only the caller's own files are purged. An id that does not exist, or belongs to someone else, is
 * left out of the result rather than raising. So is a `File` node with no `ci.files` row behind it:
 * there is nothing here to cascade, and the generic node delete has nothing to be refused over.
 *
 * @returns what went, for the caller to announce once the transaction has committed.
 */
export async function purgeFileAggregates(
  manager: EntityManager,
  userId: string,
  requestedNodeIds: string[],
  objects: StoredObjects,
  options: PurgeFileOptions = {},
): Promise<PurgedFiles> {
  const files = await lockFiles(manager, userId, { nodeIds: requestedNodeIds });

  if (files.length === 0) {
    return nothingPurged();
  }

  const fileIds = files.map((file) => file.id);
  const trail = await readFileTrail(manager, userId, fileIds);
  const asked = new Set(requestedNodeIds);
  const namedNodeIds = trail.nodes.map((node) => node.entity_id).filter((id) => asked.has(id));
  const namedFileIds = new Set(
    trail.nodes.filter((node) => asked.has(node.entity_id)).map((node) => node.linked_id),
  );

  // Read now, and only reported: see the header for why a content row that wraps a file stays.
  // `ContentService.findIdsByFileIds` is the lookup everything else uses, and this is its rule.
  const wrapping: Array<{ id: string }> = await manager.query(
    `SELECT id
       FROM ci.content
      WHERE user_id = $2
        AND external_id = ANY($1::text[])
        AND (external_id_kind = 'file' OR external_id_kind IS NULL)
      ORDER BY id`,
    [fileIds, userId],
  );

  const stored = await deleteStoredObjects(manager, files, objects, options.deadlineMs);

  if (stored.deleted > 0) {
    options.onObjectsDeleted?.(namedNodeIds);
  }

  const nodeIds = trail.nodes.map((node) => node.entity_id);

  await deleteFileRows(manager, userId, fileIds, trail);

  return {
    nodeIds,
    fileIds,
    copyFileIds: fileIds.filter((id) => !namedFileIds.has(id)),
    deletedObjects: stored.deleted,
    keptObjects: stored.kept,
    wrappingContentIds: wrapping.map((row) => row.id),
  };
}
