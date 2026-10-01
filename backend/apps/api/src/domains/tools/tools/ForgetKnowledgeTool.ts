import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { isIntegrityConstraintViolation } from '@ci/common/constants';
import { normalizeEmbeddableType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import {
  CalendarEventService,
  ContentService,
  GraphUtilityService,
  GraphNodeEntity,
  RelationshipEntity,
} from '@ci/domains/memory';
import {
  CommunicationRemovedEvent,
  ConceptRemovedEvent,
  ContentRemovedEvent,
  ItemRemovedEvent,
  PersonRemovedEvent,
  PlaceRemovedEvent,
} from '@ci/domains/memory/events';

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
 * A delete that failed after it had already destroyed something. Events and content are purged
 * first, each in its own transaction, and a purge cannot be undone, so when the rest of the call
 * is refused what was purged is gone and stays gone. This says which, rather than leaving the
 * caller to find out by trying again.
 */
class PartialForgetError extends Error {
  constructor(
    readonly deletedEntityIds: string[],
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    super(`The delete failed: ${reason}.${alreadyDeleted(deletedEntityIds)}`, { cause });
    this.name = 'PartialForgetError';
  }
}

function alreadyDeleted(ids: string[]): string {
  return ids.length ? ` Already deleted: ${ids.join(', ')}.` : '';
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
            'Archive marks nodes/relationships inactive (an event is moved to the trash, where it can be restored). archive_and_delete permanently deletes them and cannot be undone: an event goes with its attached content, and anything that came from a source that syncs again can arrive again.',
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
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ForgetKnowledgeTool.name);
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

    const explicitRelationships = relationshipIds.length
      ? await this.graphUtility.getRelationships(ownerId, {
          relationshipIds,
          includeInactive: true,
        })
      : [];

    // An Event is two rows, and a Content node has HBPE's links hanging off it, so
    // neither mode can treat them like any other node. Archive moves an event to
    // the trash; delete purges events and content. Each announces its own removal,
    // and what is left is generic.
    const nodes = uniqueEntitySnapshots.map((entry) => entry.node);
    const handledIds = hardDelete
      ? await this.purgeAggregates(nodes, ownerId)
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

          const leftBehind = hardDelete ? this.leftBehindWarning(entry.node) : null;

          if (leftBehind) {
            warnings.push(leftBehind);
          }
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
   * Delete the events and the content among `nodes` for good, and answer with the
   * ids of the nodes that are gone, which are no longer the generic path's.
   *
   * The generic path, `deactivateEntities` with `hardDelete`, deletes the node's
   * `ci.entities` row and trusts the foreign keys. For these two that cannot
   * work. HBPE has clustered nearly every event and nearly every content row, its
   * link tables reference them with no `ON DELETE` action, and the delete fails
   * outright. When it does go through it leaves rows that name the node with no
   * foreign key to say so. Each owning service does the whole teardown in one
   * transaction and announces its own removal.
   *
   * Events go first, and take their attached content with them, so a content node
   * named in the same call may already be gone when its own turn comes.
   *
   * The two are separate transactions, and neither can be undone. When the second
   * is refused after the first has committed, the error says what is already gone.
   */
  private async purgeAggregates(nodes: GraphNodeEntity[], ownerId: string): Promise<Set<string>> {
    const destroyed = new Set<string>();

    try {
      await this.purgeEvents(nodes, ownerId, destroyed);
      await this.purgeContent(nodes, ownerId, destroyed);
    } catch (error) {
      throw destroyed.size ? new PartialForgetError(Array.from(destroyed), error) : error;
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
  ): Promise<void> {
    const eventIds = nodes.filter((node) => node.entity_type === 'Event').map((node) => node.entity_id);

    if (eventIds.length === 0) {
      return;
    }

    const purged = await this.calendarEvents.purge({ userId: ownerId }, eventIds);

    purged.eventIds.forEach((id) => destroyed.add(id));

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
  ): Promise<void> {
    const contentIds = nodes
      .filter((node) => node.entity_type === 'Content' && !destroyed.has(node.entity_id))
      .map((node) => node.entity_id);

    if (contentIds.length === 0) {
      return;
    }

    const purged = await this.contents.purge({ userId: ownerId }, contentIds);

    purged.contentIds.forEach((id) => destroyed.add(id));
  }

  /**
   * An integrity violation is not worth another try. `BaseTool` marks every failure retryable,
   * which is right for a timeout or a deadlock and wrong here: a foreign key that still references
   * the row refuses the same delete the same way every time, and an agent told otherwise will keep
   * asking. So it says so, and says what to do instead. Everything else is left as `BaseTool`
   * has it.
   */
  protected handleError(error: unknown): ToolError {
    const partial = error instanceof PartialForgetError ? error : null;
    const cause = partial ? partial.cause : error;
    const progress = partial ? { deletedEntityIds: partial.deletedEntityIds } : {};

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
      message: `Cannot delete: ${blocker} still references one of the entities. Retrying will not change that. Use mode "archive" to forget without erasing.${alreadyDeleted(partial?.deletedEntityIds ?? [])}`,
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
   * mirror half of a pair whose detail row `deactivateEntities` does not touch,
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
   * delete is the mode, a `Content` node that has a `ci.content` row never reaches
   * here: {@link purgeContent} deletes it and announces it itself.
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

  /**
   * What `archive_and_delete` leaves behind for an item or a communication, said
   * to the caller, so that it does not tell the user the record is gone without
   * a trace.
   *
   * Both go through the generic delete: the node, its detail row (by cascade)
   * and its edges. No foreign key refuses it for a communication, and only an
   * item that is another item's parent is refused, which is reported as
   * `CONSTRAINT_VIOLATION`. But the rows that name one by id with no foreign key
   * are not deleted the way a purge deletes them for an event or for content: its
   * provenance ledger entries, pipeline state, tags and categories, and graph
   * deltas, which carry its title. Its search rows are announced as removed.
   * Closing the rest is a purge of its own, not done here.
   */
  private leftBehindWarning(node: GraphNodeEntity): string | null {
    const searchType = normalizeEmbeddableType(node.entity_type);

    if (searchType !== 'item' && searchType !== 'communication') {
      return null;
    }

    return `${node.entity_type} ${node.entity_id} was deleted, but rows that name it only by id were left in place: its provenance entries, pipeline state, tags and change history.`;
  }
}
