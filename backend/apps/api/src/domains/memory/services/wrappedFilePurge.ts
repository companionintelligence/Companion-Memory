import type { EntityManager } from 'typeorm';

import {
  deleteFileRows,
  deleteStoredObjects,
  lockFiles,
  readFileTrail,
  type LockedFile,
  type PurgeFileOptions,
  type StoredObjects,
} from './filePurge';

/**
 * What a purge of content, or of an event, does about the stored photo that its content wraps.
 *
 * An imported photo is two rows. `ci.files` holds the bytes, and a `ci.content` row of type `media`
 * points at it through `external_id` (the file's id, with `external_id_kind` `'file'`, or NULL on rows
 * that predate the column). There is no foreign key from content to files, so the cascade from an
 * event to its content stopped at the content row, and so did the purge of the content itself: forgetting
 * a photo's event or content left the `ci.files` row, its previews, its `File` node, its search rows,
 * and the stored bytes, which are the part that actually IS the photo. The photo stayed listed, and
 * stayed servable, after the user had been told it was gone. A file can also be tied to an event with
 * no content row at all: `ci.files.event_id` (a CI-Capture screenshot is), declared `ON DELETE SET NULL`,
 * so the event's purge nulled the link and kept the file.
 *
 * **The rule: delete the file when nothing else uses it, and keep it, and say why, when something
 * does.** It was decided with the alternatives measured: never deleting leaves every photo in the store
 * until somebody forgets its `File` node as a second step, and always deleting pulls the bytes out from
 * under records that were never named. That second one is not a corner case. On a real corpus (13,438 files, 327,168 messages), 739 files are wrapped by content,
 * one wrapper each, so "no other content row wraps it" never blocks; and 722 of those 739 are also
 * named by a message's `attachments` (228 of the 240 on an event too). Always deleting would have
 * taken 739 attachments out of messages nobody had asked about.
 *
 * What counts as using a file, because a record that is still there should not lose the thing it shows:
 *
 *  - **another content row** that wraps it (`external_id`, kind `'file'` or NULL: never `'external_uri'`,
 *    whatever it holds, which is the rule `ContentService.findIdsByFileIds` uses). Any owner, and any row
 *    whose `user_id` is NULL: a row that is not the caller's still shows the file.
 *  - **a message** whose `attachments` name it. The column is free-form (`unknown[]`) and the importer
 *    writes `[{type: 'file', id}, {type: 'content', id}]`, so this takes every uuid anywhere in the JSON
 *    text (a key, a value, a URL that carries one), which errs toward keeping.
 *  - **a chat message** that attaches it (`ci.message_files`), which would lose the attachment by cascade.
 *  - **a surviving event** it is linked to (`ci.files.event_id`): a file that belongs to an event nobody
 *    is forgetting is that event's.
 *
 * And what does not: records that merely MENTION the file. An observation that was read off the photo
 * (`ci.object_observations.file_id`), the receipt it was extracted from (`ci.receipts.source_file_id`),
 * a period summary that lists it (`ci.summaries.related_files_ids`), a link preview's poster
 * (`ci.unfurls.poster_file_id`, `SET NULL`). They are records in their own right, with no foreign key,
 * and the file purge already decided to leave them (`purgeFileAggregates`); a mention is not a reason
 * to keep the bytes of something the user asked to forget. `FILE_REFERENCE_COLUMNS` names every column
 * that can name a stored file with the decision taken about it, and the catalog guard fails when a
 * migration adds one that has no entry.
 *
 * The check covers the whole tree of the file: a preview, a thumbnail or a playback copy goes with its
 * original by cascade, so a record that still shows a variant keeps the original too.
 *
 * **Order.** The same as the file purge's, and for the same reason ({@link deleteStoredObjects}): the
 * files are locked, the objects deleted while the locks are held and BEFORE any row is, and then the
 * rows. The caller's transaction does the rest, so an object-store failure rolls the whole purge back,
 * and a database failure after the objects went leaves rows that still say where the bytes were. The
 * content row is among them, and it still wraps the file, so forgetting it again finds the same file
 * and finishes the job ({@link StoredObjectsDeletedError}).
 *
 * The files are locked BEFORE the check, and the check is a statement of its own after the locks are
 * held. Two purges that share a file serialize on its row: the second waits, and then sees what the
 * first committed. Were the check first, each would see the other's content row as a survivor and keep
 * the file, and nobody would delete it. Nothing locks the other way: no foreign key joins content or a
 * message to a file, so a record written after the check can still name a file that is about to go.
 * That window is narrow and is the same one an upload that dedupes onto a file being purged has.
 *
 * The purge of an event takes its locks in the order event, files, content. The capture linker
 * (`FileService.linkEvent`) takes a file and then a key-share on its event, so a screenshot that is being
 * linked at the very moment its event is forgotten can deadlock with the purge. Postgres detects it and aborts
 * one side with nothing deleted, which is retryable, and a different order is not worth having for it.
 *
 * The check is a scan. Neither `ci.content.external_id` nor `ci.communications.attachments` has an index,
 * so on a corpus of 105,000 content rows and 327,000 messages it costs about 0.1 s for the content and
 * between 0.7 and 2 s for the messages (11,854 of them have attachments), however many files are asked about
 * at once: both are one pass, matched by hash. It runs once per purge, only when a purge has a wrapped file
 * at all, and not once per file. (The first version searched the attachments for each file's id in turn: 0.2 s
 * for 50 files and 14.7 s for 5,000, which an album-sized event would have paid for while holding its locks.)
 *
 * Only the caller's own files are deleted, whoever owns the content that wraps them: {@link lockFiles} takes no
 * others.
 */

/** What still uses a stored file, as the ids a caller can act on. Empty when nothing does. */
export interface FileUsers {
  /** Content rows, other than the ones being purged, that wrap it. Content nodes have these ids. */
  contentIds: string[];
  /** Communications whose `attachments` name it. Communication nodes have these ids. */
  messageIds: string[];
  /** Chat messages that attach it. These are not graph nodes. */
  chatMessageIds: string[];
  /** The event it is linked to, when that event is not being purged. */
  eventId: string | null;
}

/** A file that was wrapped by what was purged, and that was kept because something else uses it. */
export interface KeptFile {
  /** The `ci.files` row. */
  fileId: string;
  /** Its `File` node: what `memory.forget` takes to delete it anyway. Null when it has none yet. */
  nodeId: string | null;
  usedBy: FileUsers;
}

/** What a purge of content or an event did about the files it wrapped, for the caller to say and announce. */
export interface WrappedFilesPurged {
  /** The wrapped files that were deleted, and not the copies that went with them. */
  wrappedFileIds: string[];
  /** Every `ci.files` row that went: the wrapped files and every variant under them. */
  fileIds: string[];
  /** The `File` nodes that went with them. */
  nodeIds: string[];
  /** How many stored objects were deleted. */
  deletedObjects: number;
  /** How many stayed, because a `ci.files` row outside this purge names the same object. */
  keptObjects: number;
  /** The wrapped files that stayed, with what uses each. */
  kept: KeptFile[];
}

export function nothingWrapped(): WrappedFilesPurged {
  return { wrappedFileIds: [], fileIds: [], nodeIds: [], deletedObjects: 0, keptObjects: 0, kept: [] };
}

/** What a purge is about to delete, which may wrap stored files. */
export interface WrappedFileSource {
  /**
   * The content rows being purged, each with the id the CALLER named that it goes with: itself, when
   * the content was named, or the event, when it goes because its event does. That id is what a caller
   * is told to forget again if the purge fails after the bytes are gone.
   */
  content: Array<{ id: string; named: string }>;
  /** The events being purged, whose directly linked files (`ci.files.event_id`) are candidates too. */
  eventIds: string[];
}

/** Where the objects of the wrapped files are deleted from, and what to do once they are gone. */
export interface WrappedFileStorage extends PurgeFileOptions {
  /** Absent in a service built without an object store, which can purge nothing that has stored bytes. */
  objects?: StoredObjects;
}

/** What {@link planWrappedFiles} decided. Everything in `doomed` is locked. */
export interface WrappedFilePlan {
  /** The files to delete: the wrapped files that nothing uses, and every variant under them. */
  doomed: LockedFile[];
  /** Of `doomed`, the wrapped files themselves. */
  wrappedFileIds: string[];
  /** The wrapped files that something uses, and so stay. */
  kept: KeptFile[];
  /** The ids the caller named whose wrapped file is in `doomed`. */
  named: string[];
}

/** A plan that deletes nothing and keeps nothing. A fresh one each time: its arrays are the caller's to read. */
const noPlan = (): WrappedFilePlan => ({ doomed: [], wrappedFileIds: [], kept: [], named: [] });

const emptyUsers = (): FileUsers => ({ contentIds: [], messageIds: [], chatMessageIds: [], eventId: null });

const isUsed = (users: FileUsers): boolean =>
  users.contentIds.length > 0 ||
  users.messageIds.length > 0 ||
  users.chatMessageIds.length > 0 ||
  users.eventId !== null;

const unique = <T>(values: T[]): T[] => Array.from(new Set(values));

const sorted = (values: string[]): string[] => unique(values).sort();

/** The shape of a uuid, so that a content row's `external_id` is only cast to one when it is. */
const UUID_SHAPE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** A uuid anywhere in some text: in a JSON value, in a URL that carries one. */
const UUID_TOKEN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

interface Candidate {
  fileId: string;
  /** The id the caller named that this file goes with. */
  named: string;
}

/**
 * The files that the purge reaches: the ones a content row being purged wraps, and the ones linked
 * straight to an event being purged. A content row's `external_id` is text, and only a uuid is a file,
 * so it is cast inside a CASE, which Postgres evaluates in order.
 *
 * Whose they are is not asked here. {@link lockFiles} takes only the caller's own, in the statement that
 * locks them, so a file that is somebody else's is dropped there, whoever's content names it. Asking in
 * both places would be a second check that nothing could observe going wrong.
 */
async function findCandidates(manager: EntityManager, source: WrappedFileSource): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  if (source.content.length > 0) {
    const named = new Map(source.content.map((content) => [content.id, content.named]));
    const wrapped: Array<{ fileId: string; contentId: string }> = await manager.query(
      `SELECT f.id AS "fileId", c.id AS "contentId"
         FROM ci.content c
         JOIN ci.files f ON f.id = (CASE WHEN c.external_id ~ $2 THEN c.external_id::uuid END)
        WHERE c.id = ANY($1::uuid[])
          AND (c.external_id_kind = 'file' OR c.external_id_kind IS NULL)
        ORDER BY c.id`,
      [source.content.map((content) => content.id), UUID_SHAPE],
    );

    for (const row of wrapped) {
      candidates.push({ fileId: row.fileId, named: named.get(row.contentId) ?? row.contentId });
    }
  }

  if (source.eventIds.length > 0) {
    const linked: Array<{ fileId: string; eventId: string }> = await manager.query(
      `SELECT id AS "fileId", event_id AS "eventId"
         FROM ci.files
        WHERE event_id = ANY($1::uuid[])
        ORDER BY id`,
      [source.eventIds],
    );

    for (const row of linked) {
      candidates.push({ fileId: row.fileId, named: row.eventId });
    }
  }

  return candidates;
}

/**
 * What still uses each of these locked files, once the purge's own content and events are discounted.
 * One query for each kind of record, over every file at once, and not one per file: none of the tables
 * is indexed for this, so each is a scan however it is asked.
 */
async function findFileUsers(
  manager: EntityManager,
  files: LockedFile[],
  source: WrappedFileSource,
): Promise<Map<string, FileUsers>> {
  const ids = files.map((file) => file.id);
  const users = new Map<string, FileUsers>(ids.map((id) => [id, emptyUsers()]));
  const usersOf = (id: string): FileUsers => users.get(id) as FileUsers;

  // A file that belongs to an event nobody is forgetting is that event's.
  const going = new Set(source.eventIds);

  for (const file of files) {
    if (file.eventId !== null && !going.has(file.eventId)) {
      usersOf(file.id).eventId = file.eventId;
    }
  }

  // Other content rows. `external_id` is text, and a file's id as text is lower case.
  const wrappers: Array<{ fileId: string; contentId: string }> = await manager.query(
    `SELECT external_id AS "fileId", id AS "contentId"
       FROM ci.content
      WHERE external_id = ANY($1::text[])
        AND (external_id_kind = 'file' OR external_id_kind IS NULL)
        AND id <> ALL($2::uuid[])
      ORDER BY id`,
    [ids, source.content.map((content) => content.id)],
  );

  for (const row of wrappers) {
    usersOf(row.fileId).contentIds.push(row.contentId);
  }

  // Messages. Every uuid anywhere in a message's attachments, whatever shape the writer gave it, is
  // pulled out of the JSON text and matched against the files by hash. That is one pass over the
  // messages that have attachments at all, however many files are asked about. Searching the text for
  // each file's id in turn costs a pass for every file: 15 s at 5,000 files on a real corpus, against
  // 1.4 s this way, and the purge holds its locks while it waits.
  const messages: Array<{ messageId: string; fileId: string }> = await manager.query(
    `SELECT DISTINCT m.id AS "messageId", lower(t.match[1]) AS "fileId"
       FROM ci.communications m
      CROSS JOIN LATERAL regexp_matches(m.attachments::text, $2, 'g') AS t(match)
      WHERE m.attachments IS NOT NULL
        AND m.attachments <> '[]'::jsonb
        AND lower(t.match[1]) = ANY($1::text[])
      ORDER BY m.id`,
    [ids, UUID_TOKEN],
  );

  for (const row of messages) {
    usersOf(row.fileId).messageIds.push(row.messageId);
  }

  const chats: Array<{ fileId: string; messageId: string }> = await manager.query(
    `SELECT file_id AS "fileId", message_id AS "messageId"
       FROM ci.message_files
      WHERE file_id = ANY($1::uuid[])
      ORDER BY message_id`,
    [ids],
  );

  for (const row of chats) {
    usersOf(row.fileId).chatMessageIds.push(row.messageId);
  }

  return users;
}

/**
 * Finds the files that content or events being purged wrap, locks them, and decides which go: a wrapped
 * file goes when nothing else uses it ({@link FileUsers}), and stays, reported, when something does.
 * Changes nothing. Call it before anything is deleted, in the transaction that deletes it, and follow it
 * with {@link deleteWrappedFileObjects} and then {@link deleteWrappedFileRows}.
 *
 * Locks the files of every candidate, kept ones too, so that nothing writes a variant under a file while
 * the decision is being made, and so that a second purge of the same file waits and then decides on what
 * this one committed.
 */
export async function planWrappedFiles(
  manager: EntityManager,
  userId: string,
  source: WrappedFileSource,
): Promise<WrappedFilePlan> {
  if (source.content.length === 0 && source.eventIds.length === 0) {
    return noPlan();
  }

  const candidates = await findCandidates(manager, source);

  if (candidates.length === 0) {
    return noPlan();
  }

  const locked = await lockFiles(manager, userId, { fileIds: unique(candidates.map((c) => c.fileId)) });

  if (locked.length === 0) {
    return noPlan();
  }

  const byId = new Map(locked.map((file) => [file.id, file]));
  const children = new Map<string, LockedFile[]>();

  for (const file of locked) {
    if (file.parentId !== null && byId.has(file.parentId)) {
      children.set(file.parentId, [...(children.get(file.parentId) ?? []), file]);
    }
  }

  const treeOf = (rootId: string): LockedFile[] => {
    const tree: LockedFile[] = [];
    const pending = [byId.get(rootId) as LockedFile];

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      tree.push(next);
      pending.push(...(children.get(next.id) ?? []));
    }

    return tree;
  };

  const users = await findFileUsers(manager, locked, source);
  const roots = sorted(candidates.map((candidate) => candidate.fileId)).filter((id) => byId.has(id));
  const doomedIds = new Set<string>();
  const keptRoots: Array<{ fileId: string; usedBy: FileUsers }> = [];

  for (const rootId of roots) {
    const tree = treeOf(rootId);
    const usedBy = emptyUsers();

    for (const file of tree) {
      const found = users.get(file.id) as FileUsers;

      usedBy.contentIds.push(...found.contentIds);
      usedBy.messageIds.push(...found.messageIds);
      usedBy.chatMessageIds.push(...found.chatMessageIds);
      usedBy.eventId ??= found.eventId;
    }

    usedBy.contentIds = sorted(usedBy.contentIds);
    usedBy.messageIds = sorted(usedBy.messageIds);
    usedBy.chatMessageIds = sorted(usedBy.chatMessageIds);

    if (isUsed(usedBy)) {
      keptRoots.push({ fileId: rootId, usedBy });
    } else {
      tree.forEach((file) => doomedIds.add(file.id));
    }
  }

  const nodes: Array<{ entity_id: string; linked_id: string }> =
    keptRoots.length > 0
      ? await manager.query(
          `SELECT entity_id, linked_id
             FROM ci.entities
            WHERE entity_type = 'File'
              AND linked_table = 'files'
              AND linked_id = ANY($1::uuid[])
              AND owner_user_id = $2
            ORDER BY entity_id`,
          [keptRoots.map((root) => root.fileId), userId],
        )
      : [];
  const nodeOf = new Map(nodes.map((node) => [node.linked_id, node.entity_id]));

  return {
    doomed: locked.filter((file) => doomedIds.has(file.id)),
    wrappedFileIds: roots.filter((id) => doomedIds.has(id)),
    kept: keptRoots.map((root) => ({ ...root, nodeId: nodeOf.get(root.fileId) ?? null })),
    named: sorted(candidates.filter((candidate) => doomedIds.has(candidate.fileId)).map((c) => c.named)),
  };
}

/**
 * Deletes the stored objects of the files the plan deletes, while every row is still in place and
 * locked ({@link deleteStoredObjects}). Once they are gone, `storage.onObjectsDeleted` is told which of the
 * ids the caller named lost its photo: whatever fails after that leaves bytes that are gone and rows that
 * are not, and the caller is the one placed to say so, because the commit can fail too.
 */
export async function deleteWrappedFileObjects(
  manager: EntityManager,
  plan: WrappedFilePlan,
  storage: WrappedFileStorage = {},
): Promise<{ deleted: number; kept: number }> {
  if (plan.doomed.length === 0) {
    return { deleted: 0, kept: 0 };
  }

  const stored = await deleteStoredObjects(manager, plan.doomed, storage.objects, storage.deadlineMs);

  if (stored.deleted > 0) {
    storage.onObjectsDeleted?.(plan.named);
  }

  return stored;
}

/**
 * Deletes the rows of the files the plan deletes ({@link deleteFileRows}): the `File` nodes, every row that
 * names them, and the `ci.files` rows with their variants. Run it after the content and the events are
 * gone, in the same transaction, and announce the result once that has committed.
 */
export async function deleteWrappedFileRows(
  manager: EntityManager,
  userId: string,
  plan: WrappedFilePlan,
  stored: { deleted: number; kept: number },
): Promise<WrappedFilesPurged> {
  if (plan.doomed.length === 0) {
    return { ...nothingWrapped(), kept: plan.kept };
  }

  const fileIds = plan.doomed.map((file) => file.id);
  const trail = await readFileTrail(manager, userId, fileIds);

  await deleteFileRows(manager, userId, fileIds, trail);

  return {
    wrappedFileIds: plan.wrappedFileIds,
    fileIds,
    nodeIds: trail.nodes.map((node) => node.entity_id),
    deletedObjects: stored.deleted,
    keptObjects: stored.kept,
    kept: plan.kept,
  };
}

/**
 * Every column that can name a stored file, and what a purge of what wraps the file does about it. A
 * column that names a file and is not here is one nobody has decided about, and the catalog guard
 * (`purgeTeardown.catalog.integration.spec.ts`) fails, by name, when a migration adds one: the wrong
 * answer is silent in both directions. Not listing a reference that should keep a file deletes the
 * bytes out from under a record that shows them; listing one that should not keeps a file the user
 * asked to forget.
 */
export const FILE_REFERENCE_COLUMNS: Record<
  string,
  { effect: 'keeps' | 'mention' | 'cascade' | 'unrelated'; reason: string }
> = {
  'ci.content.external_id': {
    effect: 'keeps',
    reason:
      'another content row that wraps the file (kind file or unclassified; external_uri is never a file). Found by what it holds, not by its name.',
  },
  'ci.communications.attachments': {
    effect: 'keeps',
    reason:
      'a message shows its attachments. Free-form JSON, so the id is looked for anywhere in its text, which errs toward keeping.',
  },
  'ci.message_files.file_id': {
    effect: 'keeps',
    reason:
      'a chat message’s attachment. The foreign key would delete the link, and the message would lose the attachment, which is not what forgetting something else means for it.',
  },
  'ci.files.event_id': {
    effect: 'keeps',
    reason:
      'the event a file is linked to. A file that belongs to an event nobody is forgetting is that event’s; one that belongs to an event being forgotten is a candidate itself.',
  },
  'ci.object_observations.file_id': {
    effect: 'mention',
    reason:
      'an observation read off the photo. A record in its own right with no foreign key, left as the file purge leaves it; not a reason to keep the bytes of something the user asked to forget.',
  },
  'ci.receipts.source_file_id': {
    effect: 'mention',
    reason: 'the document a receipt was extracted from. As above.',
  },
  'ci.summaries.related_files_ids': {
    effect: 'mention',
    reason: 'a period summary that lists the file, among others. As above.',
  },
  'ci.unfurls.poster_file_id': {
    effect: 'mention',
    reason: 'a link preview’s poster image, which the foreign key nulls. The preview stays without it.',
  },
  'ci.file_chunks.file_id': {
    effect: 'cascade',
    reason: 'the text extracted from the file. It goes with it, by cascade.',
  },
  'ci_etl.cloud_file_ingests.external_file_id': {
    effect: 'unrelated',
    reason:
      'the file’s id in the source system (a Drive file id), which a connector reads and writes. It is not the id of a `ci.files` row, and the name only looks like one.',
  },
};
