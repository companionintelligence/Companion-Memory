import { Injectable } from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  EntitySubscriberInterface,
  EventSubscriber,
  InsertEvent,
  RemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { NodeEntity, RelationshipEntity } from '@ci/domains/graph';

import { DeltaEntity, type ChangedField } from '../entities/DeltaEntity';

/**
 * TypeORM Entity Subscriber that automatically tracks changes to graph entities
 * (NodeEntity and RelationshipEntity) and records deltas in the graph_deltas table.
 *
 * This centralizes all delta tracking logic in one place, eliminating the need
 * to add tracking code to individual entity services.
 */
@Injectable()
@EventSubscriber()
export class DeltaEntitySubscriber implements EntitySubscriberInterface {
  // Store old values before updates (keyed by entity type + id)
  private oldValuesCache = new Map<string, Record<string, unknown>>();

  constructor(
    dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    // Register this subscriber with TypeORM
    dataSource.subscribers.push(this);
    this.logger.setContext(DeltaEntitySubscriber.name);
  }

  /**
   * Called before an entity is updated. We capture the old values here
   * so we can compute the delta after the update completes.
   */
  beforeUpdate(event: UpdateEvent<NodeEntity | RelationshipEntity>): void {
    if (!event.entity || !event.databaseEntity || this.isDeltaEntity(event.entity)) {
      return;
    }

    const dbEntity = event.databaseEntity as unknown as Record<string, unknown>;
    if (this.isNodeEntity(event.entity) && this.isNodeEntity(dbEntity)) {
      const key = this.getNodeCacheKey(dbEntity);
      this.oldValuesCache.set(key, this.extractNodeFields(dbEntity));
    } else if (this.isRelationshipEntity(event.entity) && this.isRelationshipEntity(dbEntity)) {
      const key = this.getRelationshipCacheKey(dbEntity);
      this.oldValuesCache.set(key, this.extractRelationshipFields(dbEntity));
    }
  }

  /**
   * Called after an entity is inserted.
   */
  async afterInsert(event: InsertEvent<NodeEntity | RelationshipEntity>): Promise<void> {
    if (!event.entity || this.isDeltaEntity(event.entity)) {
      return;
    }

    const entity = event.entity as unknown as Record<string, unknown>;

    try {
      if (this.isNodeEntity(event.entity)) {
        await this.recordNodeDelta(event.manager, entity, 'created', this.buildCreatedNodeFields(entity));
      } else if (this.isRelationshipEntity(event.entity)) {
        await this.recordRelationshipDelta(
          event.manager,
          entity,
          'created',
          this.buildCreatedRelationshipFields(entity),
        );
      }
    } catch (error) {
      this.logger.error('Failed to record insert delta', {
        error: error instanceof Error ? error.message : error,
        entityType: this.getEntityType(event.entity),
      });
    }
  }

  /**
   * Called after an entity is updated.
   */
  async afterUpdate(event: UpdateEvent<NodeEntity | RelationshipEntity>): Promise<void> {
    if (!event.entity || this.isDeltaEntity(event.entity)) {
      return;
    }

    const entity = event.entity as unknown as Record<string, unknown>;

    try {
      if (this.isNodeEntity(event.entity)) {
        const key = this.getNodeCacheKey(entity);
        const oldValues = this.oldValuesCache.get(key);
        this.oldValuesCache.delete(key);

        if (oldValues) {
          const newValues = this.extractNodeFields(entity);
          const changedFields = this.computeChangedFields(oldValues, newValues);

          if (Object.keys(changedFields).length > 0) {
            await this.recordNodeDelta(event.manager, entity, 'updated', changedFields);
          }
        }
      } else if (this.isRelationshipEntity(event.entity)) {
        const key = this.getRelationshipCacheKey(entity);
        const oldValues = this.oldValuesCache.get(key);
        this.oldValuesCache.delete(key);

        if (oldValues) {
          const newValues = this.extractRelationshipFields(entity);
          const changedFields = this.computeChangedFields(oldValues, newValues);

          if (Object.keys(changedFields).length > 0) {
            await this.recordRelationshipDelta(event.manager, entity, 'updated', changedFields);
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to record update delta', {
        error: error instanceof Error ? error.message : error,
        entityType: this.getEntityType(event.entity),
      });
    }
  }

  /**
   * Called after an entity is removed.
   */
  async afterRemove(event: RemoveEvent<NodeEntity | RelationshipEntity>): Promise<void> {
    if (!event.entity && !event.databaseEntity) {
      return;
    }

    const rawEntity = event.entity || event.databaseEntity;
    if (!rawEntity || this.isDeltaEntity(rawEntity)) {
      return;
    }

    const entity = rawEntity as unknown as Record<string, unknown>;

    try {
      if (this.isNodeEntity(rawEntity)) {
        await this.recordNodeDelta(event.manager, entity, 'deleted', this.buildDeletedNodeFields(entity));
      } else if (this.isRelationshipEntity(rawEntity)) {
        await this.recordRelationshipDelta(
          event.manager,
          entity,
          'deleted',
          this.buildDeletedRelationshipFields(entity),
        );
      }
    } catch (error) {
      this.logger.error('Failed to record delete delta', {
        error: error instanceof Error ? error.message : error,
        entityType: this.getEntityType(rawEntity),
      });
    }
  }

  /**
   * Record a delta for a node entity change.
   * Uses the event's EntityManager to save within the same transaction.
   * Handles both camelCase (graph domain) and snake_case (memory domain) entities.
   */
  private async recordNodeDelta(
    manager: EntityManager,
    entity: Record<string, unknown>,
    changeType: 'created' | 'updated' | 'deleted',
    changedFields: Record<string, ChangedField>,
  ): Promise<void> {
    // Handle both naming conventions
    const entityId = (entity.entityId ?? entity.entity_id) as string;
    const entityType = (entity.entityType ?? entity.entity_type) as string;
    const ownerUserId = (entity.userId ?? entity.owner_user_id) as string | undefined;

    const delta = manager.create(DeltaEntity, {
      deltaId: uuidv7(),
      entityId,
      nodeType: 'entity',
      entityType,
      changeType,
      changedFields,
      ownerUserId,
    });

    await manager.save(delta);

    this.logger.debug('Recorded node delta', {
      entityId,
      entityType,
      changeType,
    });
  }

  /**
   * Record a delta for a relationship entity change.
   * Uses the event's EntityManager to save within the same transaction.
   * Handles both camelCase (graph domain) and snake_case (memory domain) entities.
   */
  private async recordRelationshipDelta(
    manager: EntityManager,
    entity: Record<string, unknown>,
    changeType: 'created' | 'updated' | 'deleted',
    changedFields: Record<string, ChangedField>,
  ): Promise<void> {
    // Handle both naming conventions
    const relationshipId = (entity.id ?? entity.relationship_id) as string;
    const relationshipType = (entity.type ?? entity.relationship_type) as string;
    const fromEntityId = (entity.fromNodeId ?? entity.from_entity_id) as string;
    const toEntityId = (entity.toNodeId ?? entity.to_entity_id) as string;
    const ownerUserId = (entity.userId ?? entity.owner_user_id) as string | undefined;

    const delta = manager.create(DeltaEntity, {
      deltaId: uuidv7(),
      relationshipId,
      nodeType: 'relationship',
      relationshipType,
      fromEntityId,
      toEntityId,
      changeType,
      changedFields,
      ownerUserId,
    });

    await manager.save(delta);

    this.logger.debug('Recorded relationship delta', {
      relationshipId,
      relationshipType,
      changeType,
    });
  }

  /**
   * Type guard to detect DeltaEntity (to prevent infinite recursion).
   */
  private isDeltaEntity(entity: unknown): entity is DeltaEntity {
    return (
      entity instanceof DeltaEntity ||
      (typeof entity === 'object' && entity !== null && 'deltaId' in entity && 'nodeType' in entity)
    );
  }

  /**
   * Type guard for NodeEntity (handles both camelCase and snake_case property names).
   * - graph domain NodeEntity uses: entityId, entityType, name
   * - memory domain GraphNodeEntity uses: entity_id, entity_type, name
   */
  private isNodeEntity(entity: unknown): entity is NodeEntity {
    if (entity instanceof NodeEntity) {
      return true;
    }

    if (typeof entity !== 'object' || entity === null) {
      return false;
    }

    // Check for camelCase (graph domain) or snake_case (memory domain)
    const hasEntityId = 'entityId' in entity || 'entity_id' in entity;
    const hasEntityType = 'entityType' in entity || 'entity_type' in entity;
    const hasName = 'name' in entity;

    return hasEntityId && hasEntityType && hasName;
  }

  /**
   * Type guard for RelationshipEntity (handles both camelCase and snake_case property names).
   * - graph domain RelationshipEntity uses: fromNodeId, toNodeId, type
   * - memory domain RelationshipEntity uses: from_entity_id, to_entity_id, relationship_type
   */
  private isRelationshipEntity(entity: unknown): entity is RelationshipEntity {
    if (entity instanceof RelationshipEntity) {
      return true;
    }

    if (typeof entity !== 'object' || entity === null) {
      return false;
    }

    // Check for camelCase (graph domain) or snake_case (memory domain)
    const hasFromId = 'fromNodeId' in entity || 'from_entity_id' in entity;
    const hasToId = 'toNodeId' in entity || 'to_entity_id' in entity;
    const hasType = 'type' in entity || 'relationship_type' in entity;

    return hasFromId && hasToId && hasType;
  }

  /**
   * Get entity type string for logging (handles both naming conventions).
   */
  private getEntityType(entity: unknown): string {
    if (this.isNodeEntity(entity)) {
      const e = entity as unknown as Record<string, unknown>;

      return `Node:${e.entityType ?? e.entity_type}`;
    }

    if (this.isRelationshipEntity(entity)) {
      const e = entity as unknown as Record<string, unknown>;

      return `Relationship:${e.type ?? e.relationship_type}`;
    }

    return 'Unknown';
  }

  /**
   * Get the cache key for a node entity (handles both naming conventions).
   */
  private getNodeCacheKey(entity: Record<string, unknown>): string {
    const entityId = (entity.entityId ?? entity.entity_id) as string;

    return `node:${entityId}`;
  }

  /**
   * Get the cache key for a relationship entity (handles both naming conventions).
   */
  private getRelationshipCacheKey(entity: Record<string, unknown>): string {
    const relationshipId = (entity.id ?? entity.relationship_id) as string;

    return `relationship:${relationshipId}`;
  }

  /**
   * Extract trackable fields from a node entity (handles both naming conventions).
   */
  private extractNodeFields(entity: Record<string, unknown>): Record<string, unknown> {
    return {
      name: entity.name,
      description: entity.description,
      properties: entity.properties,
      entityType: entity.entityType ?? entity.entity_type,
    };
  }

  /**
   * Extract trackable fields from a relationship entity (handles both naming conventions).
   */
  private extractRelationshipFields(entity: Record<string, unknown>): Record<string, unknown> {
    return {
      type: entity.type ?? entity.relationship_type,
      fromNodeId: entity.fromNodeId ?? entity.from_entity_id,
      toNodeId: entity.toNodeId ?? entity.to_entity_id,
      strength: entity.strength,
      isBidirectional: entity.isBidirectional ?? entity.is_bidirectional,
      properties: entity.properties,
      startDate: entity.startDate ?? entity.start_date,
      endDate: entity.endDate ?? entity.end_date,
    };
  }

  /**
   * Build changed_fields for a newly created node (handles both naming conventions).
   */
  private buildCreatedNodeFields(entity: Record<string, unknown>): Record<string, ChangedField> {
    return {
      name: { new: entity.name },
      description: { new: entity.description },
      properties: { new: entity.properties },
    };
  }

  /**
   * Build changed_fields for a deleted node (handles both naming conventions).
   */
  private buildDeletedNodeFields(entity: Record<string, unknown>): Record<string, ChangedField> {
    return {
      name: { old: entity.name },
      description: { old: entity.description },
      properties: { old: entity.properties },
    };
  }

  /**
   * Build changed_fields for a newly created relationship (handles both naming conventions).
   */
  private buildCreatedRelationshipFields(entity: Record<string, unknown>): Record<string, ChangedField> {
    return {
      type: { new: entity.type ?? entity.relationship_type },
      fromNodeId: { new: entity.fromNodeId ?? entity.from_entity_id },
      toNodeId: { new: entity.toNodeId ?? entity.to_entity_id },
      strength: { new: entity.strength },
      isBidirectional: { new: entity.isBidirectional ?? entity.is_bidirectional },
      properties: { new: entity.properties },
    };
  }

  /**
   * Build changed_fields for a deleted relationship (handles both naming conventions).
   */
  private buildDeletedRelationshipFields(entity: Record<string, unknown>): Record<string, ChangedField> {
    return {
      type: { old: entity.type ?? entity.relationship_type },
      fromNodeId: { old: entity.fromNodeId ?? entity.from_entity_id },
      toNodeId: { old: entity.toNodeId ?? entity.to_entity_id },
      strength: { old: entity.strength },
      isBidirectional: { old: entity.isBidirectional ?? entity.is_bidirectional },
      properties: { old: entity.properties },
    };
  }

  /**
   * Compute the fields that changed between old and new values.
   */
  private computeChangedFields(
    oldValues: Record<string, unknown>,
    newValues: Record<string, unknown>,
  ): Record<string, ChangedField> {
    const changedFields: Record<string, ChangedField> = {};

    for (const key of Object.keys(newValues)) {
      const oldVal = oldValues[key];
      const newVal = newValues[key];

      // Handle Date comparison
      if (oldVal instanceof Date && newVal instanceof Date) {
        if (oldVal.getTime() !== newVal.getTime()) {
          changedFields[key] = { old: oldVal, new: newVal };
        }
      }
      // Handle object/array comparison via JSON
      else if (typeof oldVal === 'object' || typeof newVal === 'object') {
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          changedFields[key] = { old: oldVal, new: newVal };
        }
      }
      // Handle primitives
      else if (oldVal !== newVal) {
        changedFields[key] = { old: oldVal, new: newVal };
      }
    }

    return changedFields;
  }
}
