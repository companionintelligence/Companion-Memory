import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { RelationshipEntity } from '../../entities/RelationshipEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * PreferenceService - Handles preference/dislike relationships in the knowledge graph
 */
@Injectable()
export class PreferenceService {
  private logger = new LoggerService(PreferenceService.name);

  constructor(private readonly graphUtility: GraphUtilityService) {}

  /**
   * Add a preference for a person (creates concept entity if it doesn't exist)
   */
  async addPreference(
    ownerUserId: string,
    personEntityId: string,
    preference: {
      name: string;
      type:
        | 'food'
        | 'cuisine'
        | 'activity'
        | 'movie_genre'
        | 'tv_genre'
        | 'music_genre'
        | 'book_genre'
        | 'beverage'
        | 'sport'
        | 'hobby';
      isDislike?: boolean;
      strength?: number;
      properties?: Record<string, unknown>;
    },
  ): Promise<{ conceptEntity: GraphNodeEntity; relationship: RelationshipEntity }> {
    // Find or create the concept entity
    const existingConcepts = await this.graphUtility.queryNodes(
      ownerUserId,
      {
        entityType: 'Concept',
        nameContains: preference.name,
      },
      { limit: 1 },
    );

    let conceptEntity: GraphNodeEntity;
    if (
      existingConcepts.length > 0 &&
      existingConcepts[0].name?.toLowerCase() === preference.name.toLowerCase()
    ) {
      conceptEntity = existingConcepts[0];
    } else {
      const { node } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
        entityType: 'Concept',
        name: preference.name,
        description: `${preference.type}: ${preference.name}`,
        properties: {
          type: preference.type,
          ...(preference.properties ?? {}),
        },
      });
      conceptEntity = node;
    }

    // Create PREFERS or DISLIKES relationship
    const { relationship } = await this.graphUtility.createOrUpdateRelationship(ownerUserId, {
      fromEntityId: personEntityId,
      toEntityId: conceptEntity.entity_id,
      relationshipType: preference.isDislike ? 'DISLIKES' : 'PREFERS',
      strength: preference.strength ?? (preference.isDislike ? 0.7 : 0.8),
      properties: {
        context: preference.isDislike ? 'user dislike' : 'user preference',
      },
    });

    return { conceptEntity, relationship };
  }

  /**
   * Batch add preferences for a person
   */
  async addPreferences(
    ownerUserId: string,
    personEntityId: string,
    preferences: Array<{
      name: string;
      type: string;
      isDislike?: boolean;
      strength?: number;
      properties?: Record<string, unknown>;
    }>,
  ): Promise<{
    created: number;
    results: Array<{ conceptEntity: GraphNodeEntity; relationship: RelationshipEntity }>;
  }> {
    const results: Array<{ conceptEntity: GraphNodeEntity; relationship: RelationshipEntity }> = [];

    for (const pref of preferences) {
      const result = await this.addPreference(ownerUserId, personEntityId, {
        name: pref.name,
        type: pref.type as
          | 'food'
          | 'cuisine'
          | 'activity'
          | 'movie_genre'
          | 'tv_genre'
          | 'music_genre'
          | 'book_genre'
          | 'beverage'
          | 'sport'
          | 'hobby',
        isDislike: pref.isDislike,
        strength: pref.strength,
        properties: pref.properties,
      });
      results.push(result);
    }

    return { created: results.length, results };
  }

  /**
   * Get all preferences for a person
   */
  async getPreferences(
    ownerUserId: string,
    personEntityId: string,
    includeDislikes?: boolean,
  ): Promise<Array<{ concept: GraphNodeEntity; relationship: RelationshipEntity }>> {
    const relationshipTypes = includeDislikes ? ['PREFERS', 'DISLIKES'] : ['PREFERS'];

    const relationships = await this.graphUtility.getRelationships(ownerUserId, {
      entityIds: [personEntityId],
      relationshipTypes,
      direction: 'outbound',
    });

    const conceptIds = relationships.map((rel) => rel.to_entity_id);
    const concepts = await this.graphUtility.getNodesByIds(conceptIds, ownerUserId);
    const conceptMap = new Map(concepts.map((c) => [c.entity_id, c]));

    const results: Array<{ concept: GraphNodeEntity; relationship: RelationshipEntity }> = [];
    for (const rel of relationships) {
      const concept = conceptMap.get(rel.to_entity_id);
      if (concept) {
        results.push({ concept, relationship: rel });
      }
    }

    return results;
  }

  /**
   * Update a preference relationship
   */
  async updatePreference(
    ownerUserId: string,
    relationshipId: string,
    updates: {
      strength?: number;
      isDislike?: boolean;
      properties?: Record<string, unknown>;
    },
  ): Promise<RelationshipEntity> {
    const relationships = await this.graphUtility.getRelationships(ownerUserId, {
      relationshipIds: [relationshipId],
    });

    if (relationships.length === 0) {
      throw new Error(`Preference relationship with ID ${relationshipId} not found`);
    }

    const relationship = relationships[0];
    const { relationship: updated } = await this.graphUtility.createOrUpdateRelationship(ownerUserId, {
      relationshipId: relationshipId,
      fromEntityId: relationship.from_entity_id,
      toEntityId: relationship.to_entity_id,
      relationshipType:
        updates.isDislike !== undefined
          ? updates.isDislike
            ? 'DISLIKES'
            : 'PREFERS'
          : relationship.relationship_type,
      strength: updates.strength,
      properties: updates.properties,
      mergeProperties: true,
    });

    return updated;
  }

  /**
   * Delete a preference relationship
   */
  async deletePreference(ownerUserId: string, relationshipId: string): Promise<boolean> {
    const relationships = await this.graphUtility.getRelationships(ownerUserId, {
      relationshipIds: [relationshipId],
    });

    if (relationships.length === 0) {
      return false;
    }

    await this.graphUtility.softDeleteRelationship(relationshipId, ownerUserId);

    return true;
  }
}
