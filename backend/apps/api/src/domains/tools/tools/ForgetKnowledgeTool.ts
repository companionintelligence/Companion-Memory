import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { normalizeEmbeddableType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import {
  CalendarEventService,
  GraphUtilityService,
  GraphNodeEntity,
  RelationshipEntity,
} from '@ci/domains/memory';
import { ConceptRemovedEvent, PersonRemovedEvent, PlaceRemovedEvent } from '@ci/domains/memory/events';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

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
   * graph node. `restoreEvent` brings each one back as it was.
   */
  restorableEventIds?: string[];
  mode: 'archive' | 'archive_and_delete';
  warnings?: string[];
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
            'Archive marks nodes/relationships inactive (an event is moved to the trash, where it can be restored); archive_and_delete also removes them from the active graph.',
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

    const entitySnapshots = [] as Array<{
      node: GraphNodeEntity;
      relationships: RelationshipEntity[];
    }>;

    const relationshipIdsToDisable = new Set<string>();

    for (const entityId of entityIds) {
      const snapshot = await this.graphUtility.collectEntitySnapshot(entityId, ownerId, {
        includeRelationships: true,
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

    // Deactivate or delete entities and relationships according to mode
    const hardDelete = mode === 'archive_and_delete';

    const trashedEventIds = hardDelete
      ? new Set<string>()
      : await this.trashEvents(
          uniqueEntitySnapshots.map((entry) => entry.node),
          ownerId,
        );
    const graphSnapshots = uniqueEntitySnapshots.filter(
      (entry) => !trashedEventIds.has(entry.node.entity_id),
    );

    graphSnapshots.forEach((entry) =>
      entry.relationships.forEach((rel) => relationshipIdsToDisable.add(rel.relationship_id)),
    );
    explicitRelationships.forEach((rel) => relationshipIdsToDisable.add(rel.relationship_id));

    if (graphSnapshots.length) {
      await this.graphUtility.deactivateEntities(
        graphSnapshots.map((entry) => entry.node.entity_id),
        ownerId,
        hardDelete,
      );

      for (const entry of graphSnapshots) {
        await this.unindexEntity(entry.node);
      }
    }

    if (relationshipIdsToDisable.size > 0) {
      await this.graphUtility.deactivateRelationships(
        Array.from(relationshipIdsToDisable),
        ownerId,
        hardDelete,
      );
    }

    return {
      archivedEntityIds: uniqueEntitySnapshots.map((entry) => entry.node.entity_id),
      archivedRelationshipIds: Array.from(new Set(explicitRelationships.map((rel) => rel.relationship_id))),
      restorableEventIds: trashedEventIds.size ? Array.from(trashedEventIds) : undefined,
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
   * Only the types whose record IS the `ci.entities` row are handled. Every
   * other graph type (Event/Item/Content/Communication/File) is the base or
   * mirror half of a pair whose detail row `deactivateEntities` does not touch,
   * so `event.deleted` for an event that still exists in `ci.events` would be
   * false to every future consumer of that event, and unindexing it would
   * desync search from a record the rest of the app still lists. (An archived
   * Event aggregate never reaches here: {@link trashEvents} tombstones it, and
   * `CalendarEventService.remove` un-indexes it itself.)
   */
  private async unindexEntity(node: GraphNodeEntity): Promise<void> {
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
      default:
        this.logger.debug('Forgotten entity has no graph-owned search index rows to remove', {
          entityId: node.entity_id,
          entityType: node.entity_type ?? null,
          searchType,
        });

        return;
    }
  }
}
