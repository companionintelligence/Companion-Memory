import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { Events, EventService } from '@ci/domains/events';

@Injectable()
export class GraphEventService {
  constructor(
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphEventService.name);
  }

  /**
   * Queue a node write. A field left `undefined` is left out of the payload and
   * so leaves the stored value alone when `entityId` names an existing row;
   * pass `null` only to clear one. Coercing an unset field to `null` here used
   * to make every id-reuse write from `memory.remember` clear the row's linked
   * key — detaching an imported entity from the coordinate its importer upserts
   * on, so the next import minted a duplicate — along with its name,
   * description and search content.
   */
  async upsertNode(
    ownerId: string,
    input: {
      entityId?: string;
      entityType: string;
      name?: string | null;
      description?: string | null;
      properties?: Record<string, unknown>;
      searchContent?: string | null;
      linkedTable?: string | null;
      linkedId?: string | null;
      mergeProperties?: boolean;
      removeProperties?: string[];
    },
  ): Promise<{ entityId: string }> {
    const entityId = input.entityId ?? uuidv7();

    await this.eventService.send(Events.GRAPH_NODE_UPSERTED, {
      ownerId,
      node: {
        entityId,
        entityType: input.entityType,
        name: input.name,
        description: input.description,
        properties: input.properties,
        searchContent: input.searchContent,
        linkedTable: input.linkedTable,
        linkedId: input.linkedId,
        mergeProperties: input.mergeProperties,
        removeProperties: input.removeProperties,
      },
    });

    return { entityId };
  }

  /** Queue a relationship write. Same `undefined`-leaves-it-alone contract as {@link upsertNode}. */
  async upsertRelationship(
    ownerId: string,
    input: {
      relationshipId?: string;
      fromEntityId: string;
      toEntityId: string;
      relationshipType: string;
      properties?: Record<string, unknown>;
      strength?: number;
      isBidirectional?: boolean;
      startDate?: string;
      endDate?: string;
      mergeProperties?: boolean;
      removeProperties?: string[];
    },
  ): Promise<{ relationshipId: string }> {
    const relationshipId = input.relationshipId ?? uuidv7();

    await this.eventService.send(Events.GRAPH_RELATIONSHIP_UPSERTED, {
      ownerId,
      relationship: {
        relationshipId,
        fromEntityId: input.fromEntityId,
        toEntityId: input.toEntityId,
        relationshipType: input.relationshipType,
        properties: input.properties,
        strength: input.strength,
        isBidirectional: input.isBidirectional,
        startDate: input.startDate,
        endDate: input.endDate,
        mergeProperties: input.mergeProperties,
        removeProperties: input.removeProperties,
      },
    });

    return { relationshipId };
  }
}
