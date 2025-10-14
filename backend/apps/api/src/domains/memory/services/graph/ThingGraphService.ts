import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * ThingGraphService - Handles Object (Thing) entity operations in the knowledge graph
 */
@Injectable()
export class ThingGraphService {
  private logger = new LoggerService(ThingGraphService.name);

  constructor(private readonly graphUtility: GraphUtilityService) {}

  /**
   * Add a thing/object to the graph
   */
  async addThing(
    ownerUserId: string,
    thing: {
      name: string;
      type?: string;
      description?: string;
      brand?: string;
      model?: string;
      properties?: Record<string, unknown>;
    },
  ): Promise<GraphNodeEntity> {
    const { node } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityType: 'Object',
      name: thing.name,
      description: thing.description ?? `${thing.type ?? 'Object'}: ${thing.name}`,
      properties: {
        type: thing.type,
        brand: thing.brand,
        model: thing.model,
        ...(thing.properties ?? {}),
      },
    });

    return node;
  }

  /**
   * Get a thing by entity ID
   */
  async getThing(ownerUserId: string, thingEntityId: string): Promise<GraphNodeEntity | null> {
    const thing = await this.graphUtility.getNodeById(thingEntityId, ownerUserId);
    if (!thing || thing.entity_type !== 'Object') {
      return null;
    }

    return thing;
  }

  /**
   * Update a thing
   */
  async updateThing(
    ownerUserId: string,
    thingEntityId: string,
    updates: {
      name?: string;
      type?: string;
      description?: string;
      brand?: string;
      model?: string;
      properties?: Record<string, unknown>;
      mergeProperties?: boolean;
    },
  ): Promise<GraphNodeEntity> {
    const thing = await this.getThing(ownerUserId, thingEntityId);
    if (!thing) {
      throw new Error(`Thing with ID ${thingEntityId} not found`);
    }

    const { node } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityId: thingEntityId,
      entityType: 'Object',
      name: updates.name,
      description: updates.description,
      properties: updates.properties ?? {
        type: updates.type,
        brand: updates.brand,
        model: updates.model,
      },
      mergeProperties: updates.mergeProperties ?? true,
    });

    return node;
  }

  /**
   * Soft delete a thing
   */
  async deleteThing(ownerUserId: string, thingEntityId: string): Promise<boolean> {
    const thing = await this.getThing(ownerUserId, thingEntityId);
    if (!thing) {
      return false;
    }

    await this.graphUtility.softDeleteNode(thingEntityId, ownerUserId);

    return true;
  }
}
