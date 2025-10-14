import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { RelationshipEntity } from '../../entities/RelationshipEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * RelationshipService - Handles general relationship operations in the knowledge graph
 */
@Injectable()
export class RelationshipService {
  private logger = new LoggerService(RelationshipService.name);

  constructor(private readonly graphUtility: GraphUtilityService) {}

  /**
   * Connect two people with a social relationship
   */
  async addSocialConnection(
    ownerUserId: string,
    fromPersonId: string,
    toPersonId: string,
    connectionType: 'KNOWS' | 'FRIEND' | 'WORKS_WITH' | 'COLLEAGUE' | 'MENTORED' | 'TAUGHT' | 'LEARNED_FROM',
    details?: {
      since?: Date;
      context?: string;
      strength?: number;
      properties?: Record<string, unknown>;
    },
  ): Promise<RelationshipEntity> {
    const { relationship } = await this.graphUtility.createOrUpdateRelationship(ownerUserId, {
      fromEntityId: fromPersonId,
      toEntityId: toPersonId,
      relationshipType: connectionType,
      strength: details?.strength ?? 0.7,
      startDate: details?.since,
      properties: {
        context: details?.context,
        ...(details?.properties ?? {}),
      },
      isBidirectional: connectionType === 'FRIEND' || connectionType === 'COLLEAGUE',
    });

    return relationship;
  }

  /**
   * Record that a person visited a location
   */
  async addVisit(
    ownerUserId: string,
    personEntityId: string,
    locationEntityId: string,
    visitDetails?: {
      date?: Date;
      duration?: string;
      notes?: string;
      properties?: Record<string, unknown>;
    },
  ): Promise<RelationshipEntity> {
    const { relationship } = await this.graphUtility.createOrUpdateRelationship(ownerUserId, {
      fromEntityId: personEntityId,
      toEntityId: locationEntityId,
      relationshipType: 'VISITED',
      properties: {
        date: visitDetails?.date,
        duration: visitDetails?.duration,
        notes: visitDetails?.notes,
        ...(visitDetails?.properties ?? {}),
      },
    });

    return relationship;
  }

  /**
   * Get a relationship by ID
   */
  async getRelationship(ownerUserId: string, relationshipId: string): Promise<RelationshipEntity | null> {
    const relationships = await this.graphUtility.getRelationships(ownerUserId, {
      relationshipIds: [relationshipId],
    });

    return relationships.length > 0 ? relationships[0] : null;
  }

  /**
   * Update a relationship
   */
  async updateRelationship(
    ownerUserId: string,
    relationshipId: string,
    updates: {
      relationshipType?: string;
      strength?: number;
      properties?: Record<string, unknown>;
      isBidirectional?: boolean;
      startDate?: Date;
      endDate?: Date;
      mergeProperties?: boolean;
    },
  ): Promise<RelationshipEntity> {
    const relationship = await this.getRelationship(ownerUserId, relationshipId);
    if (!relationship) {
      throw new Error(`Relationship with ID ${relationshipId} not found`);
    }

    const { relationship: updated } = await this.graphUtility.createOrUpdateRelationship(ownerUserId, {
      relationshipId: relationshipId,
      fromEntityId: relationship.from_entity_id,
      toEntityId: relationship.to_entity_id,
      relationshipType: updates.relationshipType ?? relationship.relationship_type,
      strength: updates.strength,
      properties: updates.properties,
      isBidirectional: updates.isBidirectional,
      startDate: updates.startDate,
      endDate: updates.endDate,
      mergeProperties: updates.mergeProperties ?? true,
    });

    return updated;
  }

  /**
   * Delete a relationship
   */
  async deleteRelationship(ownerUserId: string, relationshipId: string): Promise<boolean> {
    const relationship = await this.getRelationship(ownerUserId, relationshipId);
    if (!relationship) {
      return false;
    }

    await this.graphUtility.softDeleteRelationship(relationshipId, ownerUserId);

    return true;
  }
}
