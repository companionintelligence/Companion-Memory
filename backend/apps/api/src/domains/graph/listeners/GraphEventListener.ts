import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/services';
import { Events, type EventPayloads, OnEvent } from '@ci/domains/events';
import { UserService } from '@ci/domains/user';

import { GraphUtilityService } from '../services/GraphUtilityService';

@Injectable()
export class GraphEventListener {
  private readonly logger = new LoggerService(GraphEventListener.name);

  constructor(
    private readonly graphUtility: GraphUtilityService,
    private readonly userService: UserService,
  ) {}

  @OnEvent(Events.GRAPH_PERSON_CREATED, { async: true })
  async handlePersonCreated(payload: EventPayloads[Events.GRAPH_PERSON_CREATED]) {
    try {
      await this.graphUtility.createOrUpdateNode(payload.ownerId, {
        entityId: payload.person.entityId,
        entityType: payload.person.entityType,
        name: payload.person.name ?? null,
        description: payload.person.description ?? null,
        properties: payload.person.properties ?? {},
      });

      if (payload.relationships?.length) {
        for (const rel of payload.relationships) {
          await this.graphUtility.createOrUpdateRelationship(payload.ownerId, {
            relationshipId: rel.relationshipId,
            fromEntityId: rel.fromEntityId,
            toEntityId: rel.toEntityId,
            relationshipType: rel.relationshipType,
            strength: rel.strength,
            properties: rel.properties,
            isBidirectional: rel.isBidirectional,
            startDate: this.parseDate(rel.startDate),
            endDate: this.parseDate(rel.endDate),
          });
        }
      }
    } catch (error) {
      this.logger.error('Failed to handle GRAPH_PERSON_CREATED', {
        ownerId: payload.ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(Events.GRAPH_FAMILY_MEMBERS_ADDED, { async: true })
  async handleFamilyMembersAdded(payload: EventPayloads[Events.GRAPH_FAMILY_MEMBERS_ADDED]) {
    for (const member of payload.members) {
      try {
        await this.graphUtility.createOrUpdateNode(payload.ownerId, {
          entityId: member.entityId,
          entityType: member.entityType,
          name: member.name ?? null,
          description: member.description ?? null,
          properties: member.properties ?? {},
        });

        for (const rel of member.relationships) {
          await this.graphUtility.createOrUpdateRelationship(payload.ownerId, {
            relationshipId: rel.relationshipId,
            fromEntityId: rel.fromEntityId,
            toEntityId: rel.toEntityId,
            relationshipType: rel.relationshipType,
            strength: rel.strength,
            properties: rel.properties,
            isBidirectional: rel.isBidirectional,
            startDate: this.parseDate(rel.startDate),
            endDate: this.parseDate(rel.endDate),
          });
        }
      } catch (error) {
        this.logger.error('Failed to handle GRAPH_FAMILY_MEMBERS_ADDED', {
          ownerId: payload.ownerId,
          memberId: member.entityId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  @OnEvent(Events.GRAPH_PREFERENCE_ADDED, { async: true })
  async handlePreferenceAdded(payload: EventPayloads[Events.GRAPH_PREFERENCE_ADDED]) {
    try {
      const conceptId = await this.ensureConcept(payload.ownerId, payload.concept);

      await this.graphUtility.createOrUpdateRelationship(payload.ownerId, {
        relationshipId: payload.relationship.relationshipId,
        fromEntityId: payload.relationship.fromEntityId,
        toEntityId: conceptId,
        relationshipType: payload.relationship.relationshipType,
        strength: payload.relationship.strength,
        properties: payload.relationship.properties,
        isBidirectional: payload.relationship.isBidirectional,
        startDate: this.parseDate(payload.relationship.startDate),
        endDate: this.parseDate(payload.relationship.endDate),
      });
    } catch (error) {
      this.logger.error('Failed to handle GRAPH_PREFERENCE_ADDED', {
        ownerId: payload.ownerId,
        concept: payload.concept.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(Events.GRAPH_PREFERENCES_ADDED, { async: true })
  async handlePreferencesAdded(payload: EventPayloads[Events.GRAPH_PREFERENCES_ADDED]) {
    for (const preference of payload.preferences) {
      try {
        const conceptId = await this.ensureConcept(payload.ownerId, preference.concept);

        await this.graphUtility.createOrUpdateRelationship(payload.ownerId, {
          relationshipId: preference.relationship.relationshipId,
          fromEntityId: preference.relationship.fromEntityId,
          toEntityId: conceptId,
          relationshipType: preference.relationship.relationshipType,
          strength: preference.relationship.strength,
          properties: preference.relationship.properties,
          isBidirectional: preference.relationship.isBidirectional,
          startDate: this.parseDate(preference.relationship.startDate),
          endDate: this.parseDate(preference.relationship.endDate),
        });
      } catch (error) {
        this.logger.error('Failed to handle GRAPH_PREFERENCES_ADDED item', {
          ownerId: payload.ownerId,
          concept: preference.concept.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  @OnEvent(Events.GRAPH_LOCATION_CREATED, { async: true })
  async handleLocationCreated(payload: EventPayloads[Events.GRAPH_LOCATION_CREATED]) {
    try {
      await this.graphUtility.createOrUpdateNode(payload.ownerId, {
        entityId: payload.location.entityId,
        entityType: payload.location.entityType,
        name: payload.location.name ?? null,
        description: payload.location.description ?? null,
        properties: payload.location.properties ?? {},
      });
    } catch (error) {
      this.logger.error('Failed to handle GRAPH_LOCATION_CREATED', {
        ownerId: payload.ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(Events.GRAPH_VISIT_RECORDED, { async: true })
  async handleVisitRecorded(payload: EventPayloads[Events.GRAPH_VISIT_RECORDED]) {
    try {
      await this.graphUtility.createOrUpdateRelationship(payload.ownerId, {
        relationshipId: payload.relationship.relationshipId,
        fromEntityId: payload.relationship.fromEntityId,
        toEntityId: payload.relationship.toEntityId,
        relationshipType: payload.relationship.relationshipType,
        strength: payload.relationship.strength,
        properties: payload.relationship.properties,
        isBidirectional: payload.relationship.isBidirectional,
        startDate: this.parseDate(payload.relationship.startDate),
        endDate: this.parseDate(payload.relationship.endDate),
      });
    } catch (error) {
      this.logger.error('Failed to handle GRAPH_VISIT_RECORDED', {
        ownerId: payload.ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(Events.GRAPH_CONNECTION_CREATED, { async: true })
  async handleConnectionCreated(payload: EventPayloads[Events.GRAPH_CONNECTION_CREATED]) {
    try {
      await this.graphUtility.createOrUpdateRelationship(payload.ownerId, {
        relationshipId: payload.relationship.relationshipId,
        fromEntityId: payload.relationship.fromEntityId,
        toEntityId: payload.relationship.toEntityId,
        relationshipType: payload.relationship.relationshipType,
        strength: payload.relationship.strength,
        properties: payload.relationship.properties,
        isBidirectional: payload.relationship.isBidirectional,
        startDate: this.parseDate(payload.relationship.startDate),
        endDate: this.parseDate(payload.relationship.endDate),
      });
    } catch (error) {
      this.logger.error('Failed to handle GRAPH_CONNECTION_CREATED', {
        ownerId: payload.ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(Events.GRAPH_NODE_DELETED, { async: true })
  async handleNodeDeleted(payload: EventPayloads[Events.GRAPH_NODE_DELETED]) {
    try {
      await this.graphUtility.softDeleteNode(payload.entityId, payload.ownerId);
    } catch (error) {
      this.logger.error('Failed to handle GRAPH_NODE_DELETED', {
        ownerId: payload.ownerId,
        entityId: payload.entityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(Events.GRAPH_NODE_UPDATED, { async: true })
  async handleNodeUpdated(payload: EventPayloads[Events.GRAPH_NODE_UPDATED]) {
    try {
      await this.graphUtility.createOrUpdateNode(payload.ownerId, {
        entityId: payload.entityId,
        name: payload.nodeName ?? null,
        description: payload.description ?? null,
        properties: payload.properties,
      });
    } catch (error) {
      this.logger.error('Failed to handle GRAPH_NODE_UPDATED', {
        ownerId: payload.ownerId,
        entityId: payload.entityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(Events.GRAPH_NODE_UPSERTED, { async: true })
  async handleNodeUpserted(payload: EventPayloads[Events.GRAPH_NODE_UPSERTED]) {
    try {
      await this.graphUtility.createOrUpdateNode(payload.ownerId, {
        entityId: payload.node.entityId,
        entityType: payload.node.entityType,
        name: payload.node.name ?? null,
        description: payload.node.description ?? null,
        properties: payload.node.properties ?? {},
        searchContent: payload.node.searchContent ?? null,
        linkedTable: payload.node.linkedTable ?? null,
        linkedId: payload.node.linkedId ?? null,
        mergeProperties: payload.node.mergeProperties,
      });
    } catch (error) {
      this.logger.error('Failed to handle GRAPH_NODE_UPSERTED', {
        ownerId: payload.ownerId,
        entityId: payload.node.entityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(Events.GRAPH_RELATIONSHIP_DELETED, { async: true })
  async handleRelationshipDeleted(payload: EventPayloads[Events.GRAPH_RELATIONSHIP_DELETED]) {
    try {
      await this.graphUtility.softDeleteRelationship(payload.relationshipId, payload.ownerId);
    } catch (error) {
      this.logger.error('Failed to handle GRAPH_RELATIONSHIP_DELETED', {
        ownerId: payload.ownerId,
        relationshipId: payload.relationshipId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(Events.GRAPH_RELATIONSHIP_UPSERTED, { async: true })
  async handleRelationshipUpserted(payload: EventPayloads[Events.GRAPH_RELATIONSHIP_UPSERTED]) {
    try {
      await this.graphUtility.createOrUpdateRelationship(payload.ownerId, {
        relationshipId: payload.relationship.relationshipId,
        fromEntityId: payload.relationship.fromEntityId,
        toEntityId: payload.relationship.toEntityId,
        relationshipType: payload.relationship.relationshipType,
        properties: payload.relationship.properties,
        strength: payload.relationship.strength,
        isBidirectional: payload.relationship.isBidirectional,
        startDate: this.parseDate(payload.relationship.startDate),
        endDate: this.parseDate(payload.relationship.endDate),
        mergeProperties: payload.relationship.mergeProperties,
      });
    } catch (error) {
      this.logger.error('Failed to handle GRAPH_RELATIONSHIP_UPSERTED', {
        ownerId: payload.ownerId,
        relationshipId: payload.relationship.relationshipId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(Events.USER_CREATED, { async: true })
  async handleUserCreated(payload: EventPayloads[Events.USER_CREATED]) {
    const user = await this.userService.findOne(payload.userId);

    if (!user) {
      this.logger.warn('User not found when handling USER_CREATED graph hook', {
        userId: payload.userId,
      });

      return;
    }

    const entityId = uuidv7();
    const nameForEntity = user.name ?? user.email;
    const nameParts = (user.name ?? '').trim().split(/\s+/).filter(Boolean);
    const [firstName, ...restName] = nameParts;

    const properties: Record<string, unknown> = {
      email: user.email,
    };

    if (firstName) {
      properties.first_name = firstName;
    }

    if (restName.length > 0) {
      properties.last_name = restName.join(' ');
    }

    try {
      await this.graphUtility.createOrUpdateNode(user.id, {
        entityId,
        entityType: 'Person',
        name: nameForEntity,
        description: nameForEntity,
        properties,
        linkedTable: 'users',
        linkedId: user.id,
      });

      await this.userService.update(user.id, { entityId });
    } catch (error) {
      this.logger.error('Failed to create graph node for new user', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureConcept(
    ownerId: string,
    concept: EventPayloads[Events.GRAPH_PREFERENCE_ADDED]['concept'],
  ): Promise<string> {
    const entityId = concept.entityId ?? uuidv7();

    await this.graphUtility.createOrUpdateNode(ownerId, {
      entityId,
      entityType: concept.entityType,
      name: concept.name ?? null,
      description: concept.description ?? null,
      properties: concept.properties ?? {},
    });

    return entityId;
  }

  private parseDate(value?: string | null): Date | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }

    return parsed;
  }
}
