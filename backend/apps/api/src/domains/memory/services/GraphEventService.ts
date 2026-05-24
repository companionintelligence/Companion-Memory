import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { Events, EventService } from '@ci/domains/events';

import { GraphQueryService } from './GraphQueryService';

type ConceptPayload = {
  entityId: string;
  entityType: 'Concept';
  name?: string;
  description?: string;
  properties?: Record<string, unknown>;
};

interface PersonRelationshipInput {
  toPersonEntityId: string;
  type: string;
  strength?: number;
  bidirectional?: boolean;
  properties?: Record<string, unknown>;
}

interface AddPersonInput {
  name: string;
  firstName?: string;
  lastName?: string;
  age?: number;
  bio?: string;
  occupation?: string;
  familyRole?: string;
  email?: string;
  phone?: string;
  properties?: Record<string, unknown>;
  relationships?: PersonRelationshipInput[];
}

interface FamilyMemberInput {
  name: string;
  relationship: string;
  age?: number;
  firstName?: string;
  lastName?: string;
  properties?: Record<string, unknown>;
}

interface AddPreferenceInput {
  personEntityId: string;
  name: string;
  type: string;
  isDislike?: boolean;
  strength?: number;
  properties?: Record<string, unknown>;
}

type BatchPreferenceInput = Omit<AddPreferenceInput, 'personEntityId'>;

interface AddLocationInput {
  name: string;
  type: string;
  coordinates?: { lat: number; lng: number };
  address?: string;
  properties?: Record<string, unknown>;
}

interface AddRelationshipInput {
  fromPersonId: string;
  toPersonId: string;
  connectionType: string;
  since?: string;
  context?: string;
  strength?: number;
  properties?: Record<string, unknown>;
}

interface AddVisitInput {
  personEntityId: string;
  locationEntityId: string;
  date?: string;
  duration?: string;
  notes?: string;
  properties?: Record<string, unknown>;
}

interface UpdateNodeInput {
  name?: string;
  description?: string;
  properties?: Record<string, unknown>;
}

@Injectable()
export class GraphEventService {
  constructor(
    private readonly eventService: EventService,
    private readonly graphQuery: GraphQueryService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphEventService.name);
  }

  async addPerson(ownerId: string, input: AddPersonInput) {
    const entityId = uuidv7();
    const personProperties: Record<string, unknown> = {
      first_name: input.firstName,
      last_name: input.lastName,
      age: input.age,
      occupation: input.occupation,
      family_role: input.familyRole,
      email: input.email,
      phone: input.phone,
      ...(input.properties ?? {}),
    };

    const relationships = (input.relationships ?? []).map((relationship) => ({
      relationshipId: uuidv7(),
      fromEntityId: entityId,
      toEntityId: relationship.toPersonEntityId,
      relationshipType: relationship.type,
      strength: relationship.strength ?? 1,
      isBidirectional: relationship.bidirectional ?? this.isFamilyRelationship(relationship.type),
      properties: relationship.properties ?? {},
    }));

    // TODO: Move this emission to the persistence layer once hard creation owns downstream events.
    await this.eventService.send(Events.GRAPH_PERSON_CREATED, {
      ownerId,
      person: {
        entityId,
        entityType: 'Person',
        name: input.name,
        description: input.bio ?? this.composePersonDescription(input),
        properties: personProperties,
      },
      relationships,
    });

    return {
      person: {
        entityId,
        name: input.name,
        properties: personProperties,
      },
      relationshipsCreated: relationships.length,
    };
  }

  async addFamilyMembers(ownerId: string, userEntityId: string, familyMembers: FamilyMemberInput[]) {
    const membersPayload = familyMembers.map((member) => {
      const entityId = uuidv7();
      const properties: Record<string, unknown> = {
        age: member.age,
        first_name: member.firstName,
        last_name: member.lastName,
        family_role: this.getFamilyRoleFromRelationship(member.relationship),
        ...(member.properties ?? {}),
      };

      return {
        entityId,
        entityType: 'Person' as const,
        name: member.name,
        description: member.name,
        properties,
        relationships: [
          {
            relationshipId: uuidv7(),
            fromEntityId: entityId,
            toEntityId: userEntityId,
            relationshipType: member.relationship,
            strength: 1,
            isBidirectional: this.isFamilyRelationship(member.relationship),
            properties: {},
          },
        ],
      };
    });

    await this.eventService.send(Events.GRAPH_FAMILY_MEMBERS_ADDED, {
      ownerId,
      members: membersPayload,
    });

    return {
      created: membersPayload.length,
      familyMembers: membersPayload.map((member) => ({
        entityId: member.entityId,
        name: member.name,
        properties: member.properties ?? {},
      })),
    };
  }

  async addPreference(ownerId: string, input: AddPreferenceInput) {
    const concept = await this.ensureConcept(ownerId, input.name, input.type, input.properties);
    const relationshipId = uuidv7();
    const relationshipType = input.isDislike ? 'DISLIKES' : 'PREFERS';
    const strength = input.strength ?? (input.isDislike ? 0.7 : 0.8);

    await this.eventService.send(Events.GRAPH_PREFERENCE_ADDED, {
      ownerId,
      concept,
      relationship: {
        relationshipId,
        fromEntityId: input.personEntityId,
        toEntityId: concept.entityId,
        relationshipType,
        strength,
        properties: {
          context: input.isDislike ? 'user dislike' : 'user preference',
        },
      },
    });

    return {
      concept: {
        entityId: concept.entityId,
        name: concept.name,
        type: input.type,
      },
      relationship: {
        id: relationshipId,
        type: relationshipType,
        strength,
      },
    };
  }

  async addPreferences(
    ownerId: string,
    input: { personEntityId: string; preferences: BatchPreferenceInput[] },
  ) {
    const preferencesPayload: Array<{
      concept: ConceptPayload;
      relationship: {
        relationshipId: string;
        fromEntityId: string;
        toEntityId: string;
        relationshipType: string;
        strength: number;
        properties: Record<string, unknown>;
      };
    }> = [];

    for (const pref of input.preferences) {
      const concept = await this.ensureConcept(ownerId, pref.name, pref.type, pref.properties);
      const relationshipType = pref.isDislike ? 'DISLIKES' : 'PREFERS';
      const strength = pref.strength ?? (pref.isDislike ? 0.7 : 0.8);

      preferencesPayload.push({
        concept,
        relationship: {
          relationshipId: uuidv7(),
          fromEntityId: input.personEntityId,
          toEntityId: concept.entityId,
          relationshipType,
          strength,
          properties: {
            context: pref.isDislike ? 'user dislike' : 'user preference',
          },
        },
      });
    }

    await this.eventService.send(Events.GRAPH_PREFERENCES_ADDED, {
      ownerId,
      preferences: preferencesPayload.map((pref) => ({
        concept: pref.concept,
        relationship: pref.relationship,
      })),
    });

    return {
      created: preferencesPayload.length,
      preferences: preferencesPayload.map((pref) => ({
        conceptId: pref.concept.entityId,
        name: pref.concept.name,
        relationshipType: pref.relationship.relationshipType,
      })),
    };
  }

  async addLocation(ownerId: string, input: AddLocationInput) {
    const entityId = uuidv7();

    await this.eventService.send(Events.GRAPH_LOCATION_CREATED, {
      ownerId,
      location: {
        entityId,
        entityType: 'Location',
        name: input.name,
        description: `${input.type}: ${input.name}`,
        properties: {
          type: input.type,
          coordinates: input.coordinates,
          address: input.address,
          ...(input.properties ?? {}),
        },
      },
    });

    return {
      location: {
        entityId,
        name: input.name,
        type: input.type,
        coordinates: input.coordinates,
      },
    };
  }

  async addVisit(ownerId: string, input: AddVisitInput) {
    const relationshipId = uuidv7();

    await this.eventService.send(Events.GRAPH_VISIT_RECORDED, {
      ownerId,
      relationship: {
        relationshipId,
        fromEntityId: input.personEntityId,
        toEntityId: input.locationEntityId,
        relationshipType: 'VISITED',
        properties: {
          date: input.date,
          duration: input.duration,
          notes: input.notes,
          ...(input.properties ?? {}),
        },
      },
    });

    return {
      visit: {
        relationshipId,
        from: input.personEntityId,
        to: input.locationEntityId,
        properties: {
          date: input.date,
          duration: input.duration,
          notes: input.notes,
          ...(input.properties ?? {}),
        },
      },
    };
  }

  async addConnection(ownerId: string, input: AddRelationshipInput) {
    const relationshipId = uuidv7();

    await this.eventService.send(Events.GRAPH_CONNECTION_CREATED, {
      ownerId,
      relationship: {
        relationshipId,
        fromEntityId: input.fromPersonId,
        toEntityId: input.toPersonId,
        relationshipType: input.connectionType,
        strength: input.strength,
        properties: {
          context: input.context,
          since: input.since,
          ...(input.properties ?? {}),
        },
        isBidirectional: ['FRIEND', 'COLLEAGUE'].includes(input.connectionType),
      },
    });

    return {
      connection: {
        relationshipId,
        from: input.fromPersonId,
        to: input.toPersonId,
        type: input.connectionType,
        strength: input.strength ?? null,
      },
    };
  }

  async deleteNode(ownerId: string, entityId: string) {
    await this.eventService.send(Events.GRAPH_NODE_DELETED, {
      ownerId,
      entityId,
    });
  }

  async updateNode(ownerId: string, entityId: string, input: UpdateNodeInput) {
    await this.eventService.send(Events.GRAPH_NODE_UPDATED, {
      ownerId,
      entityId,
      nodeName: input.name ?? null,
      description: input.description ?? null,
      properties: input.properties ?? undefined,
    });

    return {
      entityId,
      name: input.name ?? null,
      description: input.description ?? null,
      properties: input.properties ?? {},
    };
  }

  async deleteRelationship(ownerId: string, relationshipId: string) {
    await this.eventService.send(Events.GRAPH_RELATIONSHIP_DELETED, {
      ownerId,
      relationshipId,
    });
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

  private async ensureConcept(
    ownerId: string,
    name: string,
    type: string,
    properties?: Record<string, unknown>,
  ): Promise<ConceptPayload> {
    const existing = await this.graphQuery.findConceptByName(ownerId, name).catch(() => null);

    if (existing) {
      return {
        entityId: existing.entity_id,
        entityType: 'Concept',
        name: existing.name ?? name,
        description: existing.description ?? `${type}: ${name}`,
        properties: existing.properties ?? {},
      };
    }

    const entityId = uuidv7();

    return {
      entityId,
      entityType: 'Concept',
      name,
      description: `${type}: ${name}`,
      properties: {
        type,
        ...(properties ?? {}),
      },
    };
  }

  private composePersonDescription(input: AddPersonInput): string {
    const parts = [input.name];

    if (input.occupation) {
      parts.push(input.occupation);
    }

    return parts.join(', ');
  }

  private isFamilyRelationship(type: string): boolean {
    return ['SPOUSE', 'SIBLING_OF', 'FRIEND', 'COLLEAGUE'].includes(type);
  }

  private getFamilyRoleFromRelationship(relationship: string): string {
    const roleMap: Record<string, string> = {
      SPOUSE: 'spouse',
      PARENT_OF: 'child',
      CHILD_OF: 'parent',
      SIBLING_OF: 'sibling',
    };

    return roleMap[relationship] || 'family_member';
  }
}
