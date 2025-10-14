import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * EventGraphService - Handles Event entity operations in the knowledge graph
 */
@Injectable()
export class EventGraphService {
  private logger = new LoggerService(EventGraphService.name);

  constructor(private readonly graphUtility: GraphUtilityService) {}

  /**
   * Add an event to the graph
   */
  async addEvent(
    ownerUserId: string,
    event: {
      name: string;
      description?: string;
      eventType?: string;
      startTime?: Date;
      endTime?: Date;
      locationEntityId?: string;
      participantEntityIds?: string[];
      properties?: Record<string, unknown>;
    },
  ): Promise<GraphNodeEntity> {
    const { node } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityType: 'Event',
      name: event.name,
      description: event.description,
      properties: {
        event_type: event.eventType,
        start_time: event.startTime,
        end_time: event.endTime,
        location_entity_id: event.locationEntityId,
        participant_entity_ids: event.participantEntityIds,
        ...(event.properties ?? {}),
      },
    });

    // Create relationships to location and participants
    if (event.locationEntityId) {
      await this.graphUtility.createOrUpdateRelationship(ownerUserId, {
        fromEntityId: node.entity_id,
        toEntityId: event.locationEntityId,
        relationshipType: 'HAPPENED_AT',
      });
    }

    if (event.participantEntityIds) {
      for (const participantId of event.participantEntityIds) {
        await this.graphUtility.createOrUpdateRelationship(ownerUserId, {
          fromEntityId: participantId,
          toEntityId: node.entity_id,
          relationshipType: 'PARTICIPATED_IN',
        });
      }
    }

    return node;
  }

  /**
   * Get an event by entity ID
   */
  async getEvent(ownerUserId: string, eventEntityId: string): Promise<GraphNodeEntity | null> {
    const event = await this.graphUtility.getNodeById(eventEntityId, ownerUserId);
    if (!event || event.entity_type !== 'Event') {
      return null;
    }

    return event;
  }

  /**
   * Update an event
   */
  async updateEvent(
    ownerUserId: string,
    eventEntityId: string,
    updates: {
      name?: string;
      description?: string;
      eventType?: string;
      startTime?: Date;
      endTime?: Date;
      properties?: Record<string, unknown>;
      mergeProperties?: boolean;
    },
  ): Promise<GraphNodeEntity> {
    const event = await this.getEvent(ownerUserId, eventEntityId);
    if (!event) {
      throw new Error(`Event with ID ${eventEntityId} not found`);
    }

    const { node } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityId: eventEntityId,
      entityType: 'Event',
      name: updates.name,
      description: updates.description,
      properties: updates.properties ?? {
        event_type: updates.eventType,
        start_time: updates.startTime,
        end_time: updates.endTime,
      },
      mergeProperties: updates.mergeProperties ?? true,
    });

    return node;
  }

  /**
   * Soft delete an event
   */
  async deleteEvent(ownerUserId: string, eventEntityId: string): Promise<boolean> {
    const event = await this.getEvent(ownerUserId, eventEntityId);
    if (!event) {
      return false;
    }

    await this.graphUtility.softDeleteNode(eventEntityId, ownerUserId);

    return true;
  }
}
