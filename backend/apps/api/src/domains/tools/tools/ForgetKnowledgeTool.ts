import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { isIntegrityConstraintViolation } from '@ci/common/constants';
import type { RequestContext } from '@ci/common/context';
import { normalizeEmbeddableType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import {
  CalendarEventService,
  CommunicationService,
  ConceptService,
  ContentService,
  FileService,
  GraphUtilityService,
  GraphNodeEntity,
  graphEntityKindOf,
  ItemService,
  PersonService,
  PlaceService,
  ProductModelService,
  RelationshipEntity,
  StoredObjectsDeletedError,
  type KeptFile,
  type PurgedFiles,
  type WrappedFilesPurged,
} from '@ci/domains/memory';
import {
  CommunicationRemovedEvent,
  ConceptRemovedEvent,
  ContentRemovedEvent,
  ItemRemovedEvent,
  PersonRemovedEvent,
  PlaceRemovedEvent,
} from '@ci/domains/memory/events';

import type { ToolCallRefusal } from '@ci/tool-core';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolError, ToolExecutionContext } from '../core/types';

const ForgetKnowledgeInputBaseSchema = z.object({
  entityIds: z.array(z.string().uuid()).optional(),
  relationshipIds: z.array(z.string().uuid()).optional(),
  mode: z.enum(['archive', 'archive_and_delete']).default('archive'),
  reason: z.string().min(1).optional(),
});

const ForgetKnowledgeInputSchema = ForgetKnowledgeInputBaseSchema.refine(
  (value) => value.entityIds?.length || value.relationshipIds?.length,
  {
    message: 'Provide entityIds and/or relationshipIds to forget',
  },
);

export type ForgetKnowledgeInput = z.infer<typeof ForgetKnowledgeInputSchema>;

export interface ForgetKnowledgeOutput {
  archivedEntityIds: string[];
  archivedRelationshipIds: string[];
  /**
   * The events among `archivedEntityIds` that archive mode moved to the trash
   * (the same tombstone `deleteEvent` writes) rather than just deactivating a
   * graph node. `restoreEvent` brings each one back as it was. Never set for
   * `archive_and_delete`, which cannot be undone.
   */
  restorableEventIds?: string[];
  mode: 'archive' | 'archive_and_delete';
  warnings?: string[];
}

/**
 * A delete that failed after it had already destroyed something. Events, content, communications,
 * items, files, people, places and concepts are purged first, each in its own transaction, and a purge
 * cannot be undone, so when the rest of the call is refused what was purged is gone and stays gone.
 * This says which, rather than leaving the caller to find out by trying again.
 *
 * A file can also be half gone: a purge deletes its stored objects before its records, so a failure
 * in between leaves a file that is still listed and no longer opens. Those are named separately,
 * because they are not deleted and the way to finish them is to forget them again. The same goes for
 * content, events and messages, whose purge deletes the stored photo they wrap or name: the ones named are
 * the content, events or messages that are still there, holding a photo that no longer opens.
 */
class PartialForgetError extends Error {
  constructor(
    readonly deletedEntityIds: string[],
    cause: unknown,
    readonly storedObjectsDeletedFor: string[] = [],
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    super(
      `The delete failed: ${reason}.${alreadyDeleted(deletedEntityIds)}${storedContentsGone(storedObjectsDeletedFor)}`,
      { cause },
    );
    this.name = 'PartialForgetError';
  }
}

function alreadyDeleted(ids: string[]): string {
  return ids.length ? ` Already deleted: ${ids.join(', ')}.` : '';
}

/**
 * Says which files lost their stored contents without losing their records. Whether forgetting them
 * again can finish the job depends on what stopped the records going: a failure that was
 * transient can be tried again, and a foreign key that still references them cannot. The message of
 * a {@link PartialForgetError} is only shown for the first kind, because `handleError` words the
 * second itself.
 */
function storedContentsGone(ids: string[], retryHelps = true): string {
  if (ids.length === 0) {
    return '';
  }

  return ` The stored contents of these were deleted but the entities were not, so they are still listed and will not open. ${
    retryHelps
      ? 'Forgetting them again finishes the job'
      : 'Retrying cannot finish the job until what references them is removed'
  }: ${ids.join(', ')}.`;
}

/**
 * A purge that deleted the stored objects and then failed. The caller is told which of the things it named
 * are the ones left half gone, and the error that propagates is the cause, which is what says whether
 * trying again can help.
 */
function unwrapStoredObjectsDeleted(error: unknown, contentsOnly: Set<string>): unknown {
  if (error instanceof StoredObjectsDeletedError) {
    error.nodeIds.forEach((id) => contentsOnly.add(id));

    return error.cause;
  }

  return error;
}

/** What one purge of events, content or messages did about stored files, and what held them: the words its line is said in. */
interface WrappedStep {
  files: WrappedFilesPurged;
  heldBy: string;
}

const keptObjectsWarning = (count: number): string =>
  `${count} stored object(s) were not deleted because another file record still names them.`;

/** How many kept files a call lists one by one before it only counts the rest. */
const MAX_KEPT_FILES_LISTED = 10;

/** How many ids of one kind a line lists. A file one message names a hundred times over, or an album of a thousand photos, is still one line. */
const MAX_IDS_LISTED = 5;

/** "2 things", "1 sighting", or `null` for none. */
function counted(count: number, noun: string): string | null {
  return count > 0 ? `${count} ${noun}${count === 1 ? '' : 's'}` : null;
}

function listIds(ids: string[]): string {
  return ids.length > MAX_IDS_LISTED
    ? `${ids.slice(0, MAX_IDS_LISTED).join(', ')} and ${ids.length - MAX_IDS_LISTED} more`
    : ids.join(', ');
}

/**
 * The graph types archive cannot hide, under the word a refusal names them by.
 *
 * Archive only flips the `ci.entities` half of a node (`deactivateEntities`). A message, a file, a
 * content record (a photo's, a document's), a thing and a product are each a detail row that the
 * half does not reach, and search, the explorer and chat read the detail rows, so an archived one
 * went on showing while the call reported it archived. Archive refuses them and says to delete them
 * instead. An event has an archive of its own, the trash, and a person, place or concept IS its
 * `ci.entities` row.
 *
 * Only a node that HAS its detail row is refused ({@link GraphUtilityService.getNodesBackedByDetailRows}).
 * A node graph ingest wrote on its own, or a legacy `Object` or `Thing` node, has nothing else to
 * hide, so archive hides it completely, and reversibly, as before.
 */
const ARCHIVE_CANNOT_HIDE: Readonly<Record<string, string>> = {
  Communication: 'message',
  File: 'file',
  Content: 'content',
  Item: 'thing',
  // The catalog model a thing is an instance of: a `ci.product_models` row, listed beside things.
  Product: 'thing',
};

/**
 * Why an archive of these nodes is refused, or `undefined` when archive can take all of them. The
 * same words before the call is queued ({@link ForgetKnowledgeTool.checkCall}) and when it runs.
 */
function archiveRefusal(
  nodes: readonly Pick<GraphNodeEntity, 'entity_id' | 'entity_type'>[],
): string | undefined {
  const refused = new Map<string, string[]>();

  for (const node of nodes) {
    const kind = ARCHIVE_CANNOT_HIDE[node.entity_type];

    if (kind) {
      refused.set(kind, [...(refused.get(kind) ?? []), node.entity_id]);
    }
  }

  if (refused.size === 0) {
    return undefined;
  }

  const named = Array.from(refused, ([kind, ids]) => `${kind} ${listIds(ids)}`).join('; ');

  return `Archive cannot hide messages, files, content or things: archiving one only marks its graph node and it would still show in search, the explorer and chat. Nothing was changed. Refused: ${named}. Deleting them is the only way to remove them: ask the owner first, because mode "archive_and_delete" deletes them for good and cannot be undone.`;
}

/** The code a refused archive answers under, before it is queued and when it runs. */
const ARCHIVE_REFUSED = 'ARCHIVE_REFUSED';

/** An archive {@link archiveRefusal} turned down. Nothing was written, and the same call is refused again. */
class ArchiveRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveRefusedError';
  }
}

/** One line about a wrapped file that stayed: what still uses it, and how to delete it anyway. */
function keptFileWarning(kept: KeptFile): string {
  const users: string[] = [];

  if (kept.usedBy.messageIds.length > 0) {
    users.push(`message(s) ${listIds(kept.usedBy.messageIds)}`);
  }

  if (kept.usedBy.contentIds.length > 0) {
    users.push(`other content ${listIds(kept.usedBy.contentIds)}`);
  }

  if (kept.usedBy.chatMessageIds.length > 0) {
    users.push(`${kept.usedBy.chatMessageIds.length} chat message(s) that attach it`);
  }

  if (kept.usedBy.eventId !== null) {
    users.push(`event ${kept.usedBy.eventId}`);
  }

  return `Not deleted: stored file ${kept.fileId} is still used by ${users.join('; ')}.${
    kept.nodeId === null ? '' : ` Forget its File node ${kept.nodeId} to delete it anyway.`
  }`;
}

@Injectable()
export class ForgetKnowledgeTool extends BaseTool<ForgetKnowledgeInput, ForgetKnowledgeOutput> {
  readonly schema: IntentDefinition = {
    name: 'memory.forget',
    domain: 'memory',
    title: 'Forget knowledge',
    privacy: { access: 'delete', sensitivity: 'personal', destructive: true, external: false },
    // A delete is authoritative on the appliance. A device holding a partial mirror cannot show the
    // user everything a forget would remove, so it cannot honestly ask for the confirmation this
    // needs — resolveDispatch queues it regardless, and this says the same thing about the data.
    localCapable: false,
    consumes: ['concept', 'person'],
    phrases: ['Forget $fact', 'Delete what you know about $topic'],
    description: 'Archive or remove entities and relationships from the knowledge graph.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        entityIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Entity identifiers to archive or delete.',
        },
        relationshipIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Relationship identifiers to archive or delete.',
        },
        mode: {
          type: 'string',
          enum: ['archive', 'archive_and_delete'],
          default: 'archive',
          description:
            "Archive marks nodes/relationships inactive (an event is moved to the trash, where it can be restored). Archive is refused for messages, files, content and things, which would still show in search, the explorer and chat: delete those instead. archive_and_delete permanently deletes them and cannot be undone: an event goes with its attached content, an item, person, place or concept goes with the duplicates that were merged into it, a file goes with its previews and other copies and with its stored bytes, and anything that came from a source that syncs again can arrive again. The stored photo of content, of an event or of a message's attachments goes with it, bytes included, only when nothing else uses it: if another content record, another message's attachment, a chat attachment or another event still does, the file stays and is listed in warnings with what uses it and the File node to forget to delete it anyway. A message also takes the content records its attachments name (a Messenger photo's record, a Discord attachment link) unless another message or an event still holds them. A forgotten person's email addresses, phone numbers and handles are remembered as digests, so messages that still name them do not create them again; their messages and events are not deleted. An item that is another item's parent is refused until its children are named too, and the user's own person is always refused. The content record of a photo is not deleted with its file: it is listed in warnings, to be forgotten on its own.",
        },
        reason: {
          type: 'string',
          description: 'Optional description for why the knowledge was forgotten.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    examples: [
      {
        input: {
          entityIds: ['11111111-1111-1111-1111-111111111111'],
          mode: 'archive',
        },
        output: {
          archivedEntityIds: ['11111111-1111-1111-1111-111111111111'],
          archivedRelationshipIds: [],
          mode: 'archive',
        },
        description: 'Archive an entity and its outgoing relationships (soft-deactivate)',
      },
    ],
  };

  constructor(
    private readonly graphUtility: GraphUtilityService,
    private readonly eventService: EventService,
    private readonly calendarEvents: CalendarEventService,
    private readonly contents: ContentService,
    private readonly communications: CommunicationService,
    private readonly items: ItemService,
    private readonly files: FileService,
    private readonly people: PersonService,
    private readonly places: PlaceService,
    private readonly concepts: ConceptService,
    private readonly products: ProductModelService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ForgetKnowledgeTool.name);
  }

  /**
   * Refuses an archive of a message, file, content record or thing before it is queued for
   * confirmation (see `ToolHandle.checkCall`), so the owner is never asked to approve a call that
   * can only be refused. It answers under `ARCHIVE_REFUSED`, the code `execute` gives the same call.
   * Ids that aren't the caller's, or don't exist, are left to `execute`, which reports them as not
   * found.
   */
  async checkCall(context: RequestContext, input: unknown): Promise<ToolCallRefusal | undefined> {
    const parsed = ForgetKnowledgeInputSchema.safeParse(input);

    if (!parsed.success || !context.userId || parsed.data.mode === 'archive_and_delete') {
      return undefined;
    }

    const entityIds = Array.from(new Set(parsed.data.entityIds ?? []));

    if (entityIds.length === 0) {
      return undefined;
    }

    const refusal = archiveRefusal(
      await this.graphUtility.getNodesBackedByDetailRows(entityIds, context.userId),
    );

    return refusal === undefined ? undefined : { code: ARCHIVE_REFUSED, message: refusal };
  }

  protected validateInput(input: unknown): ForgetKnowledgeInput {
    return ForgetKnowledgeInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: ForgetKnowledgeInput,
  ): Promise<ForgetKnowledgeOutput> {
    if (!context.userId) {
      throw new Error('User context is required to forget knowledge');
    }

    const ownerId = context.userId;
    const mode = input.mode ?? 'archive';

    const entityIds = Array.from(new Set(input.entityIds ?? []));
    const relationshipIds = Array.from(new Set(input.relationshipIds ?? []));

    const warnings: string[] = [];

    // Deactivate or delete entities and relationships according to mode
    const hardDelete = mode === 'archive_and_delete';

    const entitySnapshots = [] as Array<{
      node: GraphNodeEntity;
      relationships: RelationshipEntity[];
    }>;

    const relationshipIdsToDisable = new Set<string>();

    for (const entityId of entityIds) {
      const snapshot = await this.graphUtility.collectEntitySnapshot(entityId, ownerId, {
        // Archive deactivates the node's outgoing edges along with it, so it needs them. A delete
        // takes every edge of the node, in both directions, in the same transaction as the node
        // (`deactivateEntities`), so there is nothing to collect for it.
        includeRelationships: !hardDelete,
        // Delete takes whatever is there. A node that archive already deactivated,
        // which is what an event in the trash is, is still a node to delete: without
        // this the second step of "archive, then delete" answers "not found".
        includeInactive: hardDelete,
      });

      if (!snapshot.node) {
        warnings.push(`Entity ${entityId} not found or not owned by user`);
        continue;
      }

      entitySnapshots.push({
        node: snapshot.node,
        relationships: snapshot.relationships,
      });
    }

    const uniqueEntitySnapshots = entitySnapshots;

    // Before anything is written, so a refused call changes nothing. `checkCall` turned this down
    // before it was queued; a call queued before that, or run without asking, is turned down here.
    // Read by id and in any state, not from the snapshots: a message archived before archive refused
    // messages is inactive, so it has no snapshot, and still shows.
    const refusal = hardDelete
      ? undefined
      : archiveRefusal(await this.graphUtility.getNodesBackedByDetailRows(entityIds, ownerId));

    if (refusal) {
      throw new ArchiveRefusedError(refusal);
    }

    const explicitRelationships = relationshipIds.length
      ? await this.graphUtility.getRelationships(ownerId, {
          relationshipIds,
          includeInactive: true,
        })
      : [];

    // An Event is two rows, a Content node has HBPE's links hanging off it, a
    // Communication leaves its participants' claims behind, an Item leaves its
    // identifiers and merge history, a File node is only the shadow of a stored
    // file, and a Person, Place or Concept leaves the identifiers it was known by
    // and everything that was merged into it, so none of them can be treated like
    // any other node. Archive moves an event to the trash; delete purges events,
    // content, communications, items, files, people, places and concepts. Each
    // announces its own removal, and what is left is generic.
    const nodes = uniqueEntitySnapshots.map((entry) => entry.node);
    const handledIds = hardDelete
      ? await this.purgeAggregates(nodes, ownerId, warnings)
      : await this.trashEvents(nodes, ownerId);
    const graphSnapshots = uniqueEntitySnapshots.filter((entry) => !handledIds.has(entry.node.entity_id));

    graphSnapshots.forEach((entry) =>
      entry.relationships.forEach((rel) => relationshipIdsToDisable.add(rel.relationship_id)),
    );
    explicitRelationships.forEach((rel) => relationshipIdsToDisable.add(rel.relationship_id));

    try {
      if (graphSnapshots.length) {
        await this.graphUtility.deactivateEntities(
          graphSnapshots.map((entry) => entry.node.entity_id),
          ownerId,
          hardDelete,
        );

        for (const entry of graphSnapshots) {
          await this.unindexEntity(entry.node, hardDelete);
        }
      }

      if (relationshipIdsToDisable.size > 0) {
        await this.graphUtility.deactivateRelationships(
          Array.from(relationshipIdsToDisable),
          ownerId,
          hardDelete,
        );
      }
    } catch (error) {
      // A trashed event comes back with `restore`. A purged event or content row does not, so say
      // which are gone.
      throw hardDelete && handledIds.size ? new PartialForgetError(Array.from(handledIds), error) : error;
    }

    return {
      archivedEntityIds: uniqueEntitySnapshots.map((entry) => entry.node.entity_id),
      archivedRelationshipIds: Array.from(new Set(explicitRelationships.map((rel) => rel.relationship_id))),
      restorableEventIds: !hardDelete && handledIds.size ? Array.from(handledIds) : undefined,
      mode,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  /**
   * Archive events the way the app deletes them: through the event's own
   * tombstone, {@link CalendarEventService.remove}.
   *
   * An Event node is only the `ci.entities` half of an aggregate. The readers
   * of the other half — the calendar, the location-enrichment stages, HBPE,
   * search hydration — decide liveness from `ci.events.is_deleted`, and none
   * of them reads `ci.entities.is_active`, the one flag `deactivateEntities`
   * writes. So deactivating the node forgot the event from the graph and
   * nowhere else.
   *
   * `remove` writes the whole tombstone in one transaction (both halves plus
   * the graph delta), then un-indexes the event and tells HBPE. It is what
   * `deleteEvent` calls, so a forgotten event is exactly a deleted one: it sits
   * in the same trash, and `restore` brings it back.
   *
   * Its relationships are left alone, as `deleteEvent` leaves them. A tombstone
   * cascades nothing, and that is what makes `restore` exact. The event's own
   * node is inactive, and the deterministic edge matrix derives no edge onto an
   * inactive endpoint.
   *
   * `remove` answers false when there is no live detail row to tombstone: an
   * `Event` node that graph ingest created with no `ci.events` row behind it,
   * or an event deleted before `remove` deactivated the base row. Both take the
   * generic path, which deactivates the node, and that is all that is left to
   * do for either.
   */
  private async trashEvents(nodes: GraphNodeEntity[], ownerId: string): Promise<Set<string>> {
    const trashed = new Set<string>();

    for (const node of nodes) {
      // The CTI discriminator: `ci.events.entity_type` is CHECKed to it, so no
      // node of any other type has a detail row to tombstone.
      if (node.entity_type !== 'Event') {
        continue;
      }

      if (await this.calendarEvents.remove({ userId: ownerId }, node.entity_id)) {
        trashed.add(node.entity_id);
      }
    }

    return trashed;
  }

  /**
   * Delete the events, content, communications, items, files, people, places and
   * concepts among `nodes` for good, and answer with the ids of the nodes that are
   * gone, which are no longer the generic path's.
   *
   * The generic path, `deactivateEntities` with `hardDelete`, deletes the node's
   * `ci.entities` row and trusts the foreign keys. For these that cannot work.
   * HBPE has clustered nearly every event and nearly every content row, its link
   * tables reference them with no `ON DELETE` action, and the delete fails
   * outright. When it does go through, and it always does for a communication, a
   * person, a place or a concept, it leaves rows that name the node with no foreign
   * key to say so. For a file it never reaches the file at all. Each owning service
   * does the whole teardown in one transaction and announces its own removal.
   *
   * Events go first, and take their attached content with them, so a content node
   * named in the same call may already be gone when its own turn comes. Messages go
   * after content, and take the content their attachments name that nothing else
   * holds. What those three did about stored files is said once, after the last of
   * them ({@link reportWrappedFiles}).
   *
   * Each is a separate transaction, and none can be undone. When a later one is
   * refused after an earlier one has committed, the error says what is already gone.
   *
   * What went that nobody named goes in `warnings`, so the caller does not tell
   * the user less than happened.
   */
  private async purgeAggregates(
    nodes: GraphNodeEntity[],
    ownerId: string,
    warnings: string[],
  ): Promise<Set<string>> {
    const destroyed = new Set<string>();
    // Entities whose stored files were deleted and which then could not be: neither destroyed nor
    // intact, and the only state a purge can leave that is. A file, or the content, event or message that
    // wrapped or named the file, depending on what was named.
    const contentsOnly = new Set<string>();
    // What each purge of events, content or messages did about stored files, said once, after all three: a
    // file that one of them kept because another record used it can be deleted by a later one in the same
    // call, when that record is among what was named, and the two lines would contradict each other.
    const wrapped: WrappedStep[] = [];

    try {
      await this.purgeEvents(nodes, ownerId, destroyed, wrapped, contentsOnly);
      await this.purgeContent(nodes, ownerId, destroyed, wrapped, contentsOnly);
      await this.purgeCommunications(nodes, ownerId, destroyed, warnings, wrapped, contentsOnly);
      this.reportWrappedFiles(wrapped, warnings);
      await this.purgePeople(nodes, ownerId, destroyed, warnings);
      await this.purgePlaces(nodes, ownerId, destroyed, warnings);
      await this.purgeConcepts(nodes, ownerId, destroyed, warnings);
      await this.purgeItems(nodes, ownerId, destroyed, warnings);
      // After the items, so a thing named in the same call is gone, not just unlinked.
      await this.purgeProducts(nodes, ownerId, destroyed, warnings);
      await this.purgeFiles(nodes, ownerId, destroyed, warnings, contentsOnly);
    } catch (error) {
      throw destroyed.size || contentsOnly.size
        ? new PartialForgetError(Array.from(destroyed), error, Array.from(contentsOnly))
        : error;
    }

    return destroyed;
  }

  /**
   * Delete events through {@link CalendarEventService.purge}.
   *
   * It takes an event in any state, so an event already in the trash is purged
   * by the same call that would have purged a live one. As with the trash, a
   * node `purge` does not take (an `Event` node with no `ci.events` row behind
   * it) goes on to the generic path, where there is nothing to cascade.
   */
  private async purgeEvents(
    nodes: GraphNodeEntity[],
    ownerId: string,
    destroyed: Set<string>,
    wrapped: WrappedStep[],
    contentsOnly: Set<string>,
  ): Promise<void> {
    const eventIds = nodes.filter((node) => node.entity_type === 'Event').map((node) => node.entity_id);

    if (eventIds.length === 0) {
      return;
    }

    let purged: Awaited<ReturnType<CalendarEventService['purge']>>;

    try {
      purged = await this.calendarEvents.purge({ userId: ownerId }, eventIds);
    } catch (error) {
      throw unwrapStoredObjectsDeleted(error, contentsOnly);
    }

    purged.eventIds.forEach((id) => destroyed.add(id));
    this.collectWrappedFiles(purged.files, 'content or event', nodes, destroyed, wrapped);

    // A content node named in this call that hung off one of those events went with it. It is gone, so
    // it is neither the next step's to purge nor the generic path's to delete.
    const named = new Set(
      nodes.filter((node) => node.entity_type === 'Content').map((node) => node.entity_id),
    );

    purged.contentIds.filter((id) => named.has(id)).forEach((id) => destroyed.add(id));
  }

  /**
   * Delete content for good, through {@link ContentService.purge}: the node, its
   * `ci.content` row, HBPE's links to it and every row that names it.
   *
   * A `Content` node `purge` does not take, because there is no `ci.content` row
   * behind it (graph ingest writes those), goes on to the generic path. HBPE
   * cannot have clustered a row that does not exist, so there is nothing for the
   * delete to be refused over.
   */
  private async purgeContent(
    nodes: GraphNodeEntity[],
    ownerId: string,
    destroyed: Set<string>,
    wrapped: WrappedStep[],
    contentsOnly: Set<string>,
  ): Promise<void> {
    const contentIds = nodes
      .filter((node) => node.entity_type === 'Content' && !destroyed.has(node.entity_id))
      .map((node) => node.entity_id);

    if (contentIds.length === 0) {
      return;
    }

    let purged: Awaited<ReturnType<ContentService['purge']>>;

    try {
      purged = await this.contents.purge({ userId: ownerId }, contentIds);
    } catch (error) {
      throw unwrapStoredObjectsDeleted(error, contentsOnly);
    }

    purged.contentIds.forEach((id) => destroyed.add(id));
    this.collectWrappedFiles(purged.files, 'content or event', nodes, destroyed, wrapped);
  }

  /**
   * Notes what a purge of content, of an event or of a message did about the stored photos it wrapped,
   * linked or named, for {@link reportWrappedFiles} to say once every such purge in the call has run.
   *
   * A `File` node that was named in this call and went with what held it is gone, so it is neither the
   * next step's to purge nor the generic path's to delete. That is marked now, and not when the call is
   * reported, so that a later failure still lists it among what was already deleted.
   */
  private collectWrappedFiles(
    files: WrappedFilesPurged,
    heldBy: string,
    nodes: GraphNodeEntity[],
    destroyed: Set<string>,
    steps: WrappedStep[],
  ): void {
    const named = new Set(nodes.filter((node) => node.entity_type === 'File').map((node) => node.entity_id));

    files.nodeIds.filter((id) => named.has(id)).forEach((id) => destroyed.add(id));
    steps.push({ files, heldBy });
  }

  /**
   * Says what the purges of content, events and messages did about the stored photos they held, which
   * nobody named and which are the part that is the photo: the ones that went, with their copies; the
   * objects that stayed because another file record names them; and the files that were kept because
   * something else still uses them, each with what uses it and the `File` node to forget to delete it
   * anyway.
   *
   * The files that stayed are judged on the whole call. A file one purge kept, because a message or a
   * content row still used it, was looked at again by the purge of that message or content row if it was
   * named too, so the last look is the one that counts, and a file that a later purge deleted is not
   * kept at all.
   */
  private reportWrappedFiles(steps: WrappedStep[], warnings: string[]): void {
    for (const { files, heldBy } of steps) {
      if (files.wrappedFileIds.length > 0) {
        const copies = files.fileIds.length - files.wrappedFileIds.length;

        warnings.push(
          `Also deleted, along with the ${heldBy} that held them, because nothing else used them: stored file(s) ${listIds(files.wrappedFileIds)}${
            copies > 0 ? `, and ${copies} copy(ies) of them (previews, thumbnails, playback versions)` : ''
          }.`,
        );
      }

      if (files.keptObjects > 0) {
        warnings.push(keptObjectsWarning(files.keptObjects));
      }
    }

    const gone = new Set(steps.flatMap(({ files }) => files.fileIds));
    const latest = new Map<string, KeptFile>();

    for (const { files } of steps) {
      files.kept.forEach((kept) => latest.set(kept.fileId, kept));
    }

    const kept = Array.from(latest.values()).filter((file) => !gone.has(file.fileId));

    kept.slice(0, MAX_KEPT_FILES_LISTED).forEach((file) => warnings.push(keptFileWarning(file)));

    if (kept.length > MAX_KEPT_FILES_LISTED) {
      warnings.push(
        `${kept.length - MAX_KEPT_FILES_LISTED} more stored file(s) were not deleted either, because something else still uses them.`,
      );
    }
  }

  /**
   * Delete communications for good, through {@link CommunicationService.purge}:
   * the node, its `ci.communications` row, and every row that names it, the
   * participants' identifier claims among them. HBPE is told which days to redo.
   *
   * What the messages' attachments name goes with them. The content rows over a message's photos
   * (Messenger's, Discord's attachment links) go unless another message or an event holds them, and the
   * stored files go when nothing else uses them. Those content rows nobody named are said in `warnings`,
   * so the caller does not tell the user less than happened, and the files are said with the ones the
   * purges of content and events deleted ({@link reportWrappedFiles}).
   *
   * A `Communication` node `purge` does not take, because there is no
   * `ci.communications` row behind it (graph ingest writes those), goes on to the
   * generic path. Nothing references a row that does not exist, so there is
   * nothing for the delete to be refused over.
   */
  private async purgeCommunications(
    nodes: GraphNodeEntity[],
    ownerId: string,
    destroyed: Set<string>,
    warnings: string[],
    wrapped: WrappedStep[],
    contentsOnly: Set<string>,
  ): Promise<void> {
    const communicationIds = nodes
      .filter((node) => node.entity_type === 'Communication')
      .map((node) => node.entity_id);

    if (communicationIds.length === 0) {
      return;
    }

    let purged: Awaited<ReturnType<CommunicationService['purge']>>;

    try {
      purged = await this.communications.purge({ userId: ownerId }, communicationIds);
    } catch (error) {
      throw unwrapStoredObjectsDeleted(error, contentsOnly);
    }

    purged.communicationIds.forEach((id) => destroyed.add(id));

    if (purged.contentIds.length > 0) {
      warnings.push(
        `Also deleted, because a message named here carried them as attachments: content ${listIds(purged.contentIds)}.`,
      );
    }

    this.collectWrappedFiles(purged.files, 'message', nodes, destroyed, wrapped);
  }

  /**
   * Delete people for good, through {@link PersonService.purge}: the node, its
   * identifiers, the pointers to it from messages and events, its merge history
   * and every row that names it.
   *
   * The addresses, phone numbers and handles they held are remembered as digests
   * so mail that still names them does not create them again. That is a thing the
   * caller should know was kept, so it is said here, and so are the duplicates that
   * were merged into a person, which went unnamed.
   *
   * The user's own node is refused, by the foreign key from `ci.users`, and the
   * refusal is reported like any other as a `CONSTRAINT_VIOLATION` that retrying
   * will not change.
   *
   * A `Person` node `purge` does not take goes on to the generic path. Every
   * spelling the graph holds a person under is taken, so that is a node the caller
   * does not own, which the snapshot has already turned away.
   */
  private async purgePeople(
    nodes: GraphNodeEntity[],
    ownerId: string,
    destroyed: Set<string>,
    warnings: string[],
  ): Promise<void> {
    const personIds = nodes
      .filter((node) => graphEntityKindOf(node.entity_type) === 'person')
      .map((node) => node.entity_id);

    if (personIds.length === 0) {
      return;
    }

    const purged = await this.people.purge({ userId: ownerId }, personIds);

    purged.personIds.forEach((id) => destroyed.add(id));

    if (purged.duplicateIds.length > 0) {
      warnings.push(
        `Also deleted, because each had been merged into a person named here: ${purged.duplicateIds.join(', ')}.`,
      );
    }

    if (purged.blockedIdentifiers > 0) {
      warnings.push(
        `${purged.blockedIdentifiers} email address(es), phone number(s) and handle(s) they used are remembered as digests, so messages that still name them do not create them again. Their messages and events were not deleted.`,
      );
    }
  }

  /**
   * Delete places for good, through {@link PlaceService.purge}: the node, its
   * identifiers, its merge history and every row that names it. Its children move
   * up to its parent first, as {@link PlaceService.remove} does.
   *
   * The events, fixes and receipts that were at the place keep their own record of
   * where, and the place is minted again from it when a new event is promoted.
   *
   * A `Location` or `Place` node `purge` does not take goes on to the generic path.
   */
  private async purgePlaces(
    nodes: GraphNodeEntity[],
    ownerId: string,
    destroyed: Set<string>,
    warnings: string[],
  ): Promise<void> {
    const placeIds = nodes
      .filter((node) => graphEntityKindOf(node.entity_type) === 'place')
      .map((node) => node.entity_id);

    if (placeIds.length === 0) {
      return;
    }

    const purged = await this.places.purge({ userId: ownerId }, placeIds);

    purged.placeIds.forEach((id) => destroyed.add(id));

    if (purged.duplicateIds.length > 0) {
      warnings.push(
        `Also deleted, because each had been merged into a place named here: ${purged.duplicateIds.join(', ')}.`,
      );
    }
  }

  /**
   * Delete concepts for good, through {@link ConceptService.purge}: the node, its
   * identifiers and every row that names it.
   *
   * A `Concept` node `purge` does not take goes on to the generic path.
   */
  private async purgeConcepts(
    nodes: GraphNodeEntity[],
    ownerId: string,
    destroyed: Set<string>,
    warnings: string[],
  ): Promise<void> {
    const conceptIds = nodes
      .filter((node) => graphEntityKindOf(node.entity_type) === 'concept')
      .map((node) => node.entity_id);

    if (conceptIds.length === 0) {
      return;
    }

    const purged = await this.concepts.purge({ userId: ownerId }, conceptIds);

    purged.conceptIds.forEach((id) => destroyed.add(id));

    if (purged.duplicateIds.length > 0) {
      warnings.push(
        `Also deleted, because each had been merged into a concept named here: ${purged.duplicateIds.join(', ')}.`,
      );
    }
  }

  /**
   * Delete items for good, through {@link ItemService.purge}: the node, its
   * `ci.objects` row, its identifiers and merge history, and every row that names
   * it.
   *
   * An item that is another item's parent is refused unless its children are named
   * in the same call, and the refusal is the foreign key's, reported like any other
   * as a `CONSTRAINT_VIOLATION` that retrying will not change.
   *
   * The duplicates that were merged into an item go with it, and nobody named them,
   * so they are said here: they are hidden tombstones the user never saw, and they
   * were destroyed.
   *
   * An `Item` node `purge` does not take, because there is no `ci.objects` row
   * behind it (graph ingest writes those), goes on to the generic path. Nothing
   * references a row that does not exist, so there is nothing for the delete to be
   * refused over.
   */
  private async purgeItems(
    nodes: GraphNodeEntity[],
    ownerId: string,
    destroyed: Set<string>,
    warnings: string[],
  ): Promise<void> {
    const itemIds = nodes.filter((node) => node.entity_type === 'Item').map((node) => node.entity_id);

    if (itemIds.length === 0) {
      return;
    }

    const purged = await this.items.purge({ userId: ownerId }, itemIds);

    purged.itemIds.forEach((id) => destroyed.add(id));

    if (purged.duplicateIds.length > 0) {
      warnings.push(
        `Also deleted, because each had been merged into an item named here: ${purged.duplicateIds.join(', ')}.`,
      );
    }
  }

  /**
   * Delete catalog products for good, through {@link ProductModelService.purge}: the
   * `ci.product_models` row, the models merged into it, its barcodes, its search rows and the node.
   *
   * The model points at its `Product` node with no `ON DELETE` action, so the generic delete of the
   * node was refused, and a product could not be forgotten in any mode. The things, sightings and
   * receipt lines that name the model stay, without it: their keys are `ON DELETE SET NULL`. That is
   * said in `warnings`, since they changed without being named.
   *
   * A `Product` node with no model behind it goes on to the generic path, where nothing refuses it.
   */
  private async purgeProducts(
    nodes: GraphNodeEntity[],
    ownerId: string,
    destroyed: Set<string>,
    warnings: string[],
  ): Promise<void> {
    const productIds = nodes.filter((node) => node.entity_type === 'Product').map((node) => node.entity_id);

    if (productIds.length === 0) {
      return;
    }

    const purged = await this.products.purge({ userId: ownerId }, productIds);

    purged.nodeIds.forEach((id) => destroyed.add(id));

    const unlinked = [
      counted(purged.unlinked.things, 'thing'),
      counted(purged.unlinked.sightings, 'sighting'),
      counted(purged.unlinked.receiptLines, 'receipt line'),
    ].filter((part): part is string => part !== null);

    if (unlinked.length > 0) {
      warnings.push(
        `Kept, and no longer linked to the deleted product: ${unlinked.length > 1 ? `${unlinked.slice(0, -1).join(', ')} and ${unlinked.at(-1)}` : unlinked[0]}.`,
      );
    }
  }

  /**
   * Delete files for good, through {@link FileService.purge}: the node, the stored
   * file it shadows, every variant under it, their chunks and search rows, and the
   * objects in the object store.
   *
   * A `File` node is only the graph's shadow of a stored file, joined to it by a
   * plain `linked_id` column, so the generic delete of the node never reached the
   * file, the bytes, or the search rows keyed by the file's id.
   *
   * The objects are deleted before the rows. If the object store fails, nothing was
   * deleted and the error is retryable. If the database fails after it, the files
   * are still listed and no longer open, and the error names them
   * ({@link StoredObjectsDeletedError}): forgetting them again finishes the job.
   *
   * What went that nobody named is said in `warnings`: the copies (previews,
   * thumbnails, playback versions) that went with a file, and any object that
   * stayed because another record still names it. So is the one thing that did not
   * go and that the user may expect to have: a photo is a file and a content record
   * that wraps it, the record keeps the filename and the description the image
   * describer wrote, and forgetting the file does not forget it. They are listed,
   * to be forgotten on their own.
   *
   * A `File` node `purge` does not take, because there is no `ci.files` row behind
   * it, goes on to the generic path. Nothing references a row that does not exist,
   * so there is nothing for the delete to be refused over.
   */
  private async purgeFiles(
    nodes: GraphNodeEntity[],
    ownerId: string,
    destroyed: Set<string>,
    warnings: string[],
    contentsOnly: Set<string>,
  ): Promise<void> {
    const named = new Set(
      nodes
        .filter((node) => node.entity_type === 'File' && !destroyed.has(node.entity_id))
        .map((node) => node.entity_id),
    );

    if (named.size === 0) {
      return;
    }

    let purged: PurgedFiles;

    try {
      purged = await this.files.purge({ userId: ownerId }, Array.from(named));
    } catch (error) {
      throw unwrapStoredObjectsDeleted(error, contentsOnly);
    }

    purged.nodeIds.filter((id) => named.has(id)).forEach((id) => destroyed.add(id));

    if (purged.copyFileIds.length > 0) {
      warnings.push(
        `Also deleted, because each was a copy (a preview, thumbnail or playback version) of a file named here: ${purged.copyFileIds.join(', ')}.`,
      );
    }

    if (purged.keptObjects > 0) {
      warnings.push(keptObjectsWarning(purged.keptObjects));
    }

    if (purged.wrappingContentIds.length > 0) {
      warnings.push(
        `Not deleted: content that wraps a deleted file, and still shows its filename and description: ${purged.wrappingContentIds.join(', ')}. Forget it separately to remove it.`,
      );
    }
  }

  /**
   * An integrity violation is not worth another try. `BaseTool` marks every failure retryable,
   * which is right for a timeout or a deadlock and wrong here: a foreign key that still references
   * the row refuses the same delete the same way every time, and an agent told otherwise will keep
   * asking. So it says so, and says what to do instead. A refused archive is the same: the same
   * call is refused the same way. Everything else is left as `BaseTool` has it.
   */
  protected handleError(error: unknown): ToolError {
    if (error instanceof ArchiveRefusedError) {
      return { code: ARCHIVE_REFUSED, message: error.message, retryable: false };
    }

    const partial = error instanceof PartialForgetError ? error : null;
    const cause = partial ? partial.cause : error;
    const progress = partial
      ? {
          ...(partial.deletedEntityIds.length > 0 ? { deletedEntityIds: partial.deletedEntityIds } : {}),
          ...(partial.storedObjectsDeletedFor.length > 0
            ? { storedObjectsDeletedFor: partial.storedObjectsDeletedFor }
            : {}),
        }
      : {};

    if (!isIntegrityConstraintViolation(cause)) {
      const base = super.handleError(error);

      return { ...base, details: { ...base.details, ...progress } };
    }

    const driver = cause as { constraint?: string; table?: string; driverError?: Record<string, string> };
    const constraint = driver.constraint ?? driver.driverError?.constraint;
    const table = driver.table ?? driver.driverError?.table;
    const blocker = constraint
      ? `constraint "${constraint}"${table ? ` on table "${table}"` : ''}`
      : 'another record';

    return {
      code: 'CONSTRAINT_VIOLATION',
      message: `Cannot delete: ${blocker} still references one of the entities. Retrying will not change that. Use mode "archive" to forget without erasing, except for messages, files, content and things, which archive cannot hide.${alreadyDeleted(partial?.deletedEntityIds ?? [])}${storedContentsGone(partial?.storedObjectsDeletedFor ?? [], false)}`,
      retryable: false,
      details: { constraint, table, ...progress },
    };
  }

  /**
   * Drop a forgotten node from the search index.
   *
   * `deactivateEntities` only flips `ci.entities.is_active` (or deletes the
   * row). `ci_search.vectors` / `ci_search.embeddings` are a separate store
   * keyed by (search type, id) and neither is reached by that write, so
   * without this the node keeps answering search and recall after the user
   * asked the appliance to forget it.
   *
   * This is the mirror image of how the node was indexed in the first place:
   * `GraphEventListener.emitSearchIndexEvent` re-emits the per-type
   * `*Created`/`*UpdatedEvent` after a graph write and the matching
   * `*SearchIndexListener` writes the tsvector and the embedding. The
   * `*RemovedEvent` is that same listener's other half — it is the only
   * consumer any of these three events has — and its handler deletes both rows
   * and clears the index-skip marker, so a node that is later recreated or
   * reactivated is re-indexed normally rather than suppressed by a stale skip.
   *
   * Archive handles only the types whose record IS the `ci.entities` row. Every
   * other graph type (Event/Item/Content/Communication/File) is the base or
   * mirror half of a pair whose detail row `deactivateEntities` does not touch
   * (which is why archive now refuses those, see {@link ARCHIVE_CANNOT_HIDE}),
   * so `event.deleted` for an event that still exists in `ci.events` would be
   * false to every future consumer of that event, and unindexing it would
   * desync search from a record the rest of the app still lists. (An Event
   * aggregate never reaches here: {@link trashEvents} tombstones it and
   * {@link purgeEvents} deletes it, and both un-index it themselves.)
   *
   * Delete is the other case for the types that have a removal event of their
   * own. The detail row (`ci.content`, `ci.objects`, `ci.communications`) goes
   * with the node, by cascade, so the record IS gone and announcing it is true.
   * Without it their search rows would wait for the nightly orphan sweep. When
   * delete is the mode, a `Content` node that has a `ci.content` row, a
   * `Communication` node that has a `ci.communications` row, or an `Item` node
   * that has a `ci.objects` row never reaches here: {@link purgeContent},
   * {@link purgeCommunications} and {@link purgeItems} delete it and announce it
   * themselves. So does a person, a place or a concept, whatever spelling it is
   * stored under ({@link purgePeople}, {@link purgePlaces}, {@link purgeConcepts}).
   *
   * A `File` node that has a `ci.files` row does not either: {@link purgeFiles}
   * deletes the file and announces `file.deleted`, whose payload is the id of the
   * `ci.files` row, because that and not the node's id is what the file's search
   * rows are keyed by. That is why there is no `file` case below. Archive refuses a
   * `File` node before it gets here.
   */
  private async unindexEntity(node: GraphNodeEntity, hardDelete: boolean): Promise<void> {
    // Reuses the canonical graph→search alias table rather than restating
    // which spellings ('Contact', 'Location', …) mean which search type.
    const searchType = normalizeEmbeddableType(node.entity_type);

    switch (searchType) {
      case 'person':
        await this.eventService.send(PersonRemovedEvent, { personId: node.entity_id });

        return;
      case 'place':
        await this.eventService.send(PlaceRemovedEvent, { placeId: node.entity_id });

        return;
      case 'concept':
        await this.eventService.send(ConceptRemovedEvent, { conceptId: node.entity_id });

        return;
      case 'content':
        if (hardDelete) {
          await this.eventService.send(ContentRemovedEvent, { contentId: node.entity_id });

          return;
        }

        break;
      case 'item':
        if (hardDelete) {
          await this.eventService.send(ItemRemovedEvent, { itemId: node.entity_id });

          return;
        }

        break;
      case 'communication':
        if (hardDelete) {
          await this.eventService.send(CommunicationRemovedEvent, { communicationId: node.entity_id });

          return;
        }

        break;
      default:
        break;
    }

    this.logger.debug('Forgotten entity has no graph-owned search index rows to remove', {
      entityId: node.entity_id,
      entityType: node.entity_type ?? null,
      searchType,
    });
  }
}
