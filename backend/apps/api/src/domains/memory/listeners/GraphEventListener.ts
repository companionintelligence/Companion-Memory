import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { type EventPayloads, Events, EventService, OnEvent } from '@ci/domains/events';

import { GraphUtilityService } from '../services/GraphUtilityService';

@Injectable()
export class GraphEventListener {
  constructor(
    private readonly graphUtility: GraphUtilityService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphEventListener.name);
  }

  @OnEvent(Events.GRAPH_PERSON_CREATED)
  async handlePersonCreated(payload: EventPayloads[Events.GRAPH_PERSON_CREATED]) {
    try {
      const searchContent = this.buildPersonSearchContent(payload.person);
      const { node, created } = await this.graphUtility.createOrUpdateNode(payload.ownerId, {
        entityId: payload.person.entityId,
        entityType: payload.person.entityType,
        name: payload.person.name ?? null,
        description: payload.person.description ?? null,
        properties: payload.person.properties ?? {},
        searchContent,
      });

      if (created && searchContent) {
        await this.enqueueEntityEmbedding(
          payload.ownerId,
          node.entity_id,
          payload.person.entityType,
          searchContent,
        );
      }

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

  @OnEvent(Events.GRAPH_FAMILY_MEMBERS_ADDED)
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

  @OnEvent(Events.GRAPH_PREFERENCE_ADDED)
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

  @OnEvent(Events.GRAPH_PREFERENCES_ADDED)
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

  @OnEvent(Events.GRAPH_LOCATION_CREATED)
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

  @OnEvent(Events.GRAPH_VISIT_RECORDED)
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

  @OnEvent(Events.GRAPH_CONNECTION_CREATED)
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

  @OnEvent(Events.GRAPH_NODE_DELETED)
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

  @OnEvent(Events.GRAPH_NODE_UPDATED)
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

  @OnEvent(Events.GRAPH_NODE_UPSERTED)
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

  @OnEvent(Events.GRAPH_RELATIONSHIP_DELETED)
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

  @OnEvent(Events.GRAPH_RELATIONSHIP_UPSERTED)
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

  private buildPersonSearchContent(
    person: EventPayloads[Events.GRAPH_PERSON_CREATED]['person'],
  ): string | null {
    const parts = new Set<string>();

    const push = (value: unknown) => {
      if (typeof value !== 'string') {
        return;
      }

      const normalized = value.trim();
      if (normalized.length === 0) {
        return;
      }

      parts.add(normalized);
    };

    push(person.name ?? null);
    push(person.description ?? null);

    const properties = (person.properties ?? {}) as Record<string, unknown>;
    const candidateKeys = ['first_name', 'last_name', 'email', 'occupation', 'bio'];

    for (const key of candidateKeys) {
      push(properties[key]);
    }

    const aliases = properties['aliases'];
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        push(alias);
      }
    }

    const result = Array.from(parts).join(' ');

    return result.length > 0 ? result : null;
  }

  private async enqueueEntityEmbedding(
    ownerId: string,
    entityId: string,
    entityType: string,
    searchContent: string,
  ): Promise<void> {
    await this.eventService.send(Events.SEARCH_EMBED_ENTITY, {
      ownerId,
      entityId,
      entityType,
      searchContent,
    });
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
