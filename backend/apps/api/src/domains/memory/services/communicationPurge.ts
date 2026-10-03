import type { EntityManager } from 'typeorm';

import { teardownContent } from './contentPurge';
import { COMMUNICATION_REFERENCES, deleteBareReferences } from './purgeTeardown';
import {
  deleteWrappedFileObjects,
  deleteWrappedFileRows,
  nothingWrapped,
  planWrappedFiles,
  UUID_TOKEN,
  type WrappedFilesPurged,
  type WrappedFileStorage,
} from './wrappedFilePurge';

/** What one purge removed, for the caller to announce once the transaction has committed. */
export interface PurgedCommunications {
  /** The communications that went, each with the time HBPE needs to re-serialise that day. */
  communications: Array<{ id: string; time: Date }>;
  /** The content rows their attachments named that went with them. */
  contentIds: string[];
  /** What was done about the stored files their attachments name, and the ones those content rows wrap. */
  files: WrappedFilesPurged;
}

/** A content row that goes with the messages that carry it, and the message that is the one the caller named. */
interface AttachmentContent {
  id: string;
  /** The purged message that names it, which is what a caller is told to forget again if the purge fails. */
  named: string;
}

/**
 * The content rows that the attachments of these messages name, and that go with them.
 *
 * `ci.communications.attachments` is free-form JSON that the importer fills with `{type: 'file', id}` and
 * `{type: 'content', id}` entries. The content rows are the importer's own: Messenger writes one over every
 * photo it stores (identified by the message's own identity and the bytes' hash), and Discord writes one for
 * every attachment link, with no file behind it at all. They exist because of the message, and what a
 * message carried goes with it as an event's content goes with the event. WhatsApp writes none: a photo in a
 * chat is a standalone content row there, which no `attachments` names, and so stays.
 *
 * A row goes only if it is the caller's, which is `user_id`, as everywhere else in the purges; if no event
 * holds it (`event_id`: an event's content is the event's, and goes when the event does, or stays); and if no
 * message that survives names it. A row two messages share goes with the last of them, in either order, as
 * a shared file does. Like the rest of the check it looks for the id anywhere in the text of the
 * attachments, which errs toward keeping.
 *
 * The decision is made before the files are locked, so two purges of messages that share a content row, run at
 * the same moment, each see the other's message as one that survives, and neither takes it. That leaves a row
 * that a purge of it, or of the file it wraps, takes later. The files themselves converge: they are decided
 * after their locks are held ({@link planWrappedFiles}).
 */
async function findAttachmentContent(
  manager: EntityManager,
  userId: string,
  messageIds: string[],
): Promise<AttachmentContent[]> {
  // Only the purged messages' own rows are read, by key, so this is cheap however many messages exist.
  const attached: Array<{ contentId: string; messageId: string }> = await manager.query(
    `SELECT DISTINCT c.id AS "contentId", m.id AS "messageId"
       FROM ci.communications m
      CROSS JOIN LATERAL regexp_matches(m.attachments::text, $3, 'g') AS t(match)
       JOIN ci.content c ON c.id = lower(t.match[1])::uuid
      WHERE m.id = ANY($1::uuid[])
        AND c.user_id = $2
        AND c.event_id IS NULL
      ORDER BY c.id, m.id`,
    [messageIds, userId, UUID_TOKEN],
  );

  if (attached.length === 0) {
    return [];
  }

  const candidateIds = Array.from(new Set(attached.map((row) => row.contentId)));

  // The one other pass over the messages, and only when a purged message names a content row at all: the
  // ones that survive and name any of these, matched by hash like the check on the files is.
  const shared: Array<{ contentId: string }> = await manager.query(
    `SELECT DISTINCT lower(t.match[1]) AS "contentId"
       FROM ci.communications m
      CROSS JOIN LATERAL regexp_matches(m.attachments::text, $3, 'g') AS t(match)
      WHERE m.attachments IS NOT NULL
        AND m.attachments <> '[]'::jsonb
        AND m.id <> ALL($1::uuid[])
        AND lower(t.match[1]) = ANY($2::text[])`,
    [messageIds, candidateIds, UUID_TOKEN],
  );
  const stays = new Set(shared.map((row) => row.contentId));
  const named = new Map<string, string>();

  for (const row of attached) {
    // The rows are in key order, so the first message to name a content row is the same one every time.
    if (!stays.has(row.contentId) && !named.has(row.contentId)) {
      named.set(row.contentId, row.messageId);
    }
  }

  return Array.from(named, ([id, by]) => ({ id, named: by }));
}

/**
 * Permanently deletes communications, and everything that has no meaning without
 * them, inside the caller's transaction.
 *
 * Deleting the `ci.entities` base row of a communication is enough to remove the
 * communication itself. It cascades to the `ci.communications` detail row, and
 * nothing in the schema references that row, so unlike an event or content item
 * the delete is never refused. What it does is leave rows that point at nothing:
 *
 *  1. **Everything that names the id with no foreign key**
 *     ({@link deleteBareReferences}): the edges in both directions, the
 *     provenance ledger, the pipeline state and dead letters, the tags and
 *     categories, the search index and the graph deltas, whose `created` delta
 *     carries the subject line.
 *  2. **The identifier claims.** The person-link stage writes one for every
 *     address and phone number a message names, keyed by the message's id. Each
 *     is the raw sender or recipient, and the duplicate-detection stage groups
 *     them to propose that two people are one, so a claim that outlived its
 *     message would go on giving evidence from a conversation the user asked to forget.
 *  3. **What its attachments name.** `attachments` is JSON that joins to nothing, so a
 *     message that carried a photo left the photo: the content rows over it
 *     ({@link findAttachmentContent}), the stored file, its previews, its `File` node, its search
 *     rows and the bytes. The content rows go with the message. The files go when nothing else
 *     uses them, and stay, reported in the result, when something does: a content row that stays,
 *     another message, a chat attachment, an event ({@link planWrappedFiles}). The files are decided and
 *     their objects deleted BEFORE any row is, so a failure in the object store rolls everything back, and
 *     a failure after it leaves rows that still say where the bytes were, the message among them, still
 *     naming the file, so forgetting it again finishes the job.
 *
 * What it deliberately leaves alone is every record that merely MENTIONS the
 * communication. The people on it are nodes in their own right, as are the
 * summaries that were written about the period it fell in, whose
 * `related_communications_ids` still list it. Forgetting a message does not forget
 * who sent it.
 *
 * It is not {@link CommunicationService.remove}. That is the app's delete: it
 * writes a `deleted` graph delta, which carries the title, and leaves the edges,
 * ledger rows and claims where they are. This is `memory.forget`'s
 * `archive_and_delete`: a node's deltas are deleted with it and none is written.
 *
 * The rows are locked first, in key order, so two purges cannot deadlock each
 * other and so the `time` read for HBPE is the committed one: a writer that is
 * moving the message to another day holds the row, and this waits for it rather
 * than naming the day the message has just left. The files are locked after the messages
 * and before the content, which is the order the purges of content and of events take them in.
 *
 * Only the caller's own communications are purged. An id that does not exist, or
 * that belongs to someone else, is left out of the result rather than raising. So
 * is a `Communication` node with no `ci.communications` row behind it, which
 * graph ingest can write: there is nothing here to cascade, and the generic node
 * delete has nothing to be refused over.
 *
 * @param storage the object store, for the stored files this deletes. Without one, a purge that would
 *   have to delete stored bytes is refused before anything is changed; a message with no files needs none.
 */
export async function purgeCommunicationAggregates(
  manager: EntityManager,
  userId: string,
  requestedCommunicationIds: string[],
  storage?: WrappedFileStorage,
): Promise<PurgedCommunications> {
  const communications: Array<{ id: string; time: Date }> = await manager.query(
    `SELECT id, "time"
       FROM ci.communications
      WHERE id = ANY($1::uuid[])
        AND user_id = $2
      ORDER BY id
        FOR UPDATE`,
    [requestedCommunicationIds, userId],
  );

  if (communications.length === 0) {
    return { communications: [], contentIds: [], files: nothingWrapped() };
  }

  const communicationIds = communications.map((communication) => communication.id);
  const attached = await findAttachmentContent(manager, userId, communicationIds);
  const contentIds = attached.map((content) => content.id);

  // The files are locked, decided and have their objects deleted before anything else is touched. The
  // content that goes with the messages is among what is being purged, so it does not keep a file.
  const plan = await planWrappedFiles(manager, userId, {
    content: attached,
    eventIds: [],
    messageIds: communicationIds,
  });
  const stored = await deleteWrappedFileObjects(manager, plan, storage);

  await teardownContent(manager, contentIds);
  await deleteBareReferences(manager, communicationIds, COMMUNICATION_REFERENCES);
  await manager.query(
    `DELETE FROM ci.entities WHERE entity_type = 'Communication' AND entity_id = ANY($1::uuid[])`,
    [communicationIds],
  );

  // Last, so that the content that wrapped the files and the messages that named them are gone first.
  const files = await deleteWrappedFileRows(manager, userId, plan, stored);

  return { communications, contentIds, files };
}
