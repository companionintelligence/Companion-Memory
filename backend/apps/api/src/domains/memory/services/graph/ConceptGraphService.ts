import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * ConceptGraphService - Handles Concept entity operations in the knowledge graph
 */
@Injectable()
export class ConceptGraphService {
  private logger = new LoggerService(ConceptGraphService.name);

  constructor(private readonly graphUtility: GraphUtilityService) {}

  /**
   * Add a concept to the graph
   */
  async addConcept(
    ownerUserId: string,
    concept: {
      name: string;
      type: string;
      description?: string;
      properties?: Record<string, unknown>;
    },
  ): Promise<GraphNodeEntity> {
    const { node } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityType: 'Concept',
      name: concept.name,
      description: concept.description ?? `${concept.type}: ${concept.name}`,
      properties: {
        type: concept.type,
        ...(concept.properties ?? {}),
      },
    });

    return node;
  }

  /**
   * Get a concept by entity ID
   */
  async getConcept(ownerUserId: string, conceptEntityId: string): Promise<GraphNodeEntity | null> {
    const concept = await this.graphUtility.getNodeById(conceptEntityId, ownerUserId);
    if (!concept || concept.entity_type !== 'Concept') {
      return null;
    }

    return concept;
  }

  /**
   * Update a concept
   */
  async updateConcept(
    ownerUserId: string,
    conceptEntityId: string,
    updates: {
      name?: string;
      type?: string;
      description?: string;
      properties?: Record<string, unknown>;
      mergeProperties?: boolean;
    },
  ): Promise<GraphNodeEntity> {
    const concept = await this.getConcept(ownerUserId, conceptEntityId);
    if (!concept) {
      throw new Error(`Concept with ID ${conceptEntityId} not found`);
    }

    const { node } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityId: conceptEntityId,
      entityType: 'Concept',
      name: updates.name,
      description: updates.description,
      properties: updates.properties ?? { type: updates.type },
      mergeProperties: updates.mergeProperties ?? true,
    });

    return node;
  }

  /**
   * Soft delete a concept
   */
  async deleteConcept(ownerUserId: string, conceptEntityId: string): Promise<boolean> {
    const concept = await this.getConcept(ownerUserId, conceptEntityId);
    if (!concept) {
      return false;
    }

    await this.graphUtility.softDeleteNode(conceptEntityId, ownerUserId);

    return true;
  }
}
