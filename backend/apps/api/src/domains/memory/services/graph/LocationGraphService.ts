import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * LocationGraphService - Handles Location entity operations in the knowledge graph
 */
@Injectable()
export class LocationGraphService {
  private logger = new LoggerService(LocationGraphService.name);

  constructor(private readonly graphUtility: GraphUtilityService) {}

  /**
   * Add a location to the graph
   */
  async addLocation(
    ownerUserId: string,
    location: {
      name: string;
      type: string;
      coordinates?: { lat: number; lng: number };
      address?: string;
      properties?: Record<string, unknown>;
    },
  ): Promise<GraphNodeEntity> {
    const { node } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityType: 'Location',
      name: location.name,
      description: `${location.type}: ${location.name}`,
      properties: {
        type: location.type,
        coordinates: location.coordinates,
        address: location.address,
        ...(location.properties ?? {}),
      },
    });

    return node;
  }

  /**
   * Get a location by entity ID
   */
  async getLocation(ownerUserId: string, locationEntityId: string): Promise<GraphNodeEntity | null> {
    const location = await this.graphUtility.getNodeById(locationEntityId, ownerUserId);
    if (!location || location.entity_type !== 'Location') {
      return null;
    }

    return location;
  }

  /**
   * Update a location
   */
  async updateLocation(
    ownerUserId: string,
    locationEntityId: string,
    updates: {
      name?: string;
      type?: string;
      coordinates?: { lat: number; lng: number };
      address?: string;
      properties?: Record<string, unknown>;
      mergeProperties?: boolean;
    },
  ): Promise<GraphNodeEntity> {
    const location = await this.getLocation(ownerUserId, locationEntityId);
    if (!location) {
      throw new Error(`Location with ID ${locationEntityId} not found`);
    }

    const { node } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityId: locationEntityId,
      entityType: 'Location',
      name: updates.name,
      description: updates.type ? `${updates.type}: ${updates.name ?? location.name}` : undefined,
      properties: updates.properties ?? {
        type: updates.type,
        coordinates: updates.coordinates,
        address: updates.address,
      },
      mergeProperties: updates.mergeProperties ?? true,
    });

    return node;
  }

  /**
   * Soft delete a location
   */
  async deleteLocation(ownerUserId: string, locationEntityId: string): Promise<boolean> {
    const location = await this.getLocation(ownerUserId, locationEntityId);
    if (!location) {
      return false;
    }

    await this.graphUtility.softDeleteNode(locationEntityId, ownerUserId);

    return true;
  }
}
