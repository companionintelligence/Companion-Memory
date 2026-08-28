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
    },
  ): Promise<{ entityId: string }> {
    const entityId = input.entityId ?? uuidv7();

    await this.eventService.send(Events.GRAPH_NODE_UPSERTED, {
      ownerId,
      node: {
        entityId,
        entityType: input.entityType,
        name: input.name ?? null,
        description: input.description ?? null,
        properties: input.properties ?? {},
        searchContent: input.searchContent ?? null,
        linkedTable: input.linkedTable ?? null,
        linkedId: input.linkedId ?? null,
        mergeProperties: input.mergeProperties,
      },
    });

    return { entityId };
  }

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
        properties: input.properties ?? {},
        strength: input.strength,
        isBidirectional: input.isBidirectional,
        startDate: input.startDate,
        endDate: input.endDate,
        mergeProperties: input.mergeProperties,
      },
    });

    return { relationshipId };
  }
}
