import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * PersonGraphService - Handles Person entity operations in the knowledge graph
 */
@Injectable()
export class PersonGraphService {
  private logger = new LoggerService(PersonGraphService.name);

  constructor(private readonly graphUtility: GraphUtilityService) {}

  /**
   * Helper to determine if a relationship type is typically bidirectional
   */
  private isFamilyRelationship(type: string): boolean {
    return ['SPOUSE', 'SIBLING_OF', 'FRIEND', 'COLLEAGUE'].includes(type);
  }

  /**
   * Helper to infer family role from relationship type
   */
  private getFamilyRoleFromRelationship(relationship: string): string {
    const roleMap: Record<string, string> = {
      SPOUSE: 'spouse',
      PARENT_OF: 'child',
      CHILD_OF: 'parent',
      SIBLING_OF: 'sibling',
    };

    return roleMap[relationship] || 'family_member';
  }

  /**
   * Add a person to the user's graph with optional relationships
   */
  async addPerson(
    ownerUserId: string,
    person: {
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
    },
    relationships?: Array<{
      toPersonEntityId: string;
      type: string;
      strength?: number;
      bidirectional?: boolean;
      properties?: Record<string, unknown>;
    }>,
  ): Promise<{ personEntity: GraphNodeEntity; relationshipsCreated: number }> {
    const { node: personEntity } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityType: 'Person',
      name: person.name,
      description: person.bio ?? `${person.name}${person.occupation ? `, ${person.occupation}` : ''}`,
      properties: {
        first_name: person.firstName,
        last_name: person.lastName,
        age: person.age,
        occupation: person.occupation,
        family_role: person.familyRole,
        email: person.email,
        phone: person.phone,
        ...(person.properties ?? {}),
      },
    });

    let relationshipsCreated = 0;
    if (relationships && relationships.length > 0) {
      for (const rel of relationships) {
        await this.graphUtility.createOrUpdateRelationship(ownerUserId, {
          fromEntityId: personEntity.entity_id,
          toEntityId: rel.toPersonEntityId,
          relationshipType: rel.type,
          strength: rel.strength ?? 1.0,
          isBidirectional: rel.bidirectional ?? this.isFamilyRelationship(rel.type),
          properties: rel.properties ?? {},
        });
        relationshipsCreated++;
      }
    }

    return { personEntity, relationshipsCreated };
  }

  /**
   * Get a person by entity ID
   */
  async getPerson(ownerUserId: string, personEntityId: string): Promise<GraphNodeEntity | null> {
    const person = await this.graphUtility.getNodeById(personEntityId, ownerUserId);
    if (!person || person.entity_type !== 'Person') {
      return null;
    }

    return person;
  }

  /**
   * Update a person's properties
   */
  async updatePerson(
    ownerUserId: string,
    personEntityId: string,
    updates: {
      name?: string;
      firstName?: string;
      lastName?: string;
      age?: number;
      bio?: string;
      occupation?: string;
      familyRole?: string;
      email?: string;
      phone?: string;
      properties?: Record<string, unknown>;
      mergeProperties?: boolean;
    },
  ): Promise<GraphNodeEntity> {
    const person = await this.getPerson(ownerUserId, personEntityId);
    if (!person) {
      throw new Error(`Person with ID ${personEntityId} not found`);
    }

    const { node } = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityId: personEntityId,
      entityType: 'Person',
      name: updates.name,
      description: updates.bio ?? person.description,
      properties: updates.properties
        ? updates.properties
        : {
            first_name: updates.firstName,
            last_name: updates.lastName,
            age: updates.age,
            occupation: updates.occupation,
            family_role: updates.familyRole,
            email: updates.email,
            phone: updates.phone,
          },
      mergeProperties: updates.mergeProperties ?? true,
    });

    return node;
  }

  /**
   * Soft delete a person
   */
  async deletePerson(ownerUserId: string, personEntityId: string): Promise<boolean> {
    const person = await this.getPerson(ownerUserId, personEntityId);
    if (!person) {
      return false;
    }

    await this.graphUtility.softDeleteNode(personEntityId, ownerUserId);

    return true;
  }

  /**
   * Batch add family members with relationships
   */
  async addFamilyMembers(
    ownerUserId: string,
    userEntityId: string,
    familyMembers: Array<{
      name: string;
      relationship: string;
      age?: number;
      firstName?: string;
      lastName?: string;
      properties?: Record<string, unknown>;
    }>,
  ): Promise<{ created: number; entities: GraphNodeEntity[] }> {
    const entities: GraphNodeEntity[] = [];

    for (const member of familyMembers) {
      const { personEntity } = await this.addPerson(
        ownerUserId,
        {
          name: member.name,
          firstName: member.firstName,
          lastName: member.lastName,
          age: member.age,
          familyRole: this.getFamilyRoleFromRelationship(member.relationship),
          properties: member.properties,
        },
        [
          {
            toPersonEntityId: userEntityId,
            type: member.relationship,
            bidirectional: true,
          },
        ],
      );
      entities.push(personEntity);
    }

    return { created: entities.length, entities };
  }

  /**
   * Get all nodes (entities) for a user
   */
  async getAllNodes(
    ownerUserId: string,
    filters?: {
      entityType?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<GraphNodeEntity[]> {
    return this.graphUtility.queryNodes(
      ownerUserId,
      { entityType: filters?.entityType },
      { limit: filters?.limit || 200, offset: filters?.offset || 0 },
    );
  }

  /**
   * Update a node (entity) in the graph
   */
  async updateNode(
    ownerUserId: string,
    entityId: string,
    updates: {
      name?: string;
      description?: string;
      properties?: Record<string, unknown>;
    },
  ): Promise<GraphNodeEntity> {
    const result = await this.graphUtility.createOrUpdateNode(ownerUserId, {
      entityId,
      name: updates.name,
      description: updates.description,
      properties: updates.properties,
      mergeProperties: true,
    });

    return result.node;
  }

  /**
   * Delete a node (soft delete)
   */
  async deleteNode(ownerUserId: string, entityId: string): Promise<void> {
    await this.graphUtility.softDeleteNode(entityId, ownerUserId);
  }
}
