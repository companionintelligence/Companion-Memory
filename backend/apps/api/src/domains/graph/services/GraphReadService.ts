import { Injectable } from '@nestjs/common';

import { GraphNodeEntity } from '../entities/GraphNodeEntity';

import { GraphQueryService } from './GraphQueryService';

interface FamilyMemberSummary {
  entityId: string;
  name: string | null;
  relationshipType: string;
  direction: 'outbound' | 'inbound';
  strength: number;
  properties?: Record<string, unknown>;
}

interface PreferenceSummary {
  entityId: string;
  name: string | null;
  type: string;
  strength: number;
  relationship: 'PREFERS' | 'DISLIKES';
  properties?: Record<string, unknown> | null;
}

@Injectable()
export class GraphReadService {
  private static readonly DEFAULT_FAMILY_RELATIONSHIPS = [
    'SPOUSE',
    'PARTNER',
    'ROMANTIC_PARTNER',
    'PARENT_OF',
    'CHILD_OF',
    'SIBLING_OF',
    'FAMILY_MEMBER',
  ];

  constructor(private readonly graphQuery: GraphQueryService) {}

  /**
   * Lightweight helper around GraphQueryService.getNode
   */
  getNode(ownerId: string, entityId: string): Promise<GraphNodeEntity | null> {
    return this.graphQuery.getNode(ownerId, entityId);
  }

  /**
   * Returns immediate family members for the given user.
   * Optionally supply relationship types or a different person entity id.
   */
  async getFamilyMembers(
    ownerId: string,
    options: {
      relationshipTypes?: string[];
      personEntityId?: string;
    } = {},
  ): Promise<FamilyMemberSummary[]> {
    const subjectNode = options.personEntityId
      ? { entity_id: options.personEntityId }
      : await this.graphQuery.getUserEntity(ownerId);

    if (!subjectNode) {
      return [];
    }

    const relationshipTypes =
      options.relationshipTypes && options.relationshipTypes.length > 0
        ? options.relationshipTypes
        : GraphReadService.DEFAULT_FAMILY_RELATIONSHIPS;

    const relationships = await this.graphQuery.getRelationships(ownerId, {
      entityIds: [subjectNode.entity_id],
      relationshipTypes,
      direction: 'both',
    });

    if (relationships.length === 0) {
      return [];
    }

    const otherIds = Array.from(
      new Set(
        relationships.map((rel) =>
          rel.from_entity_id === subjectNode.entity_id ? rel.to_entity_id : rel.from_entity_id,
        ),
      ),
    );

    const nodes = await this.graphQuery.getNodesByIds(ownerId, otherIds);
    const nodeMap = new Map(nodes.map((node) => [node.entity_id, node]));

    const summaries: FamilyMemberSummary[] = [];

    for (const rel of relationships) {
      const direction = rel.from_entity_id === subjectNode.entity_id ? 'outbound' : 'inbound';
      const otherId = direction === 'outbound' ? rel.to_entity_id : rel.from_entity_id;
      const otherNode = nodeMap.get(otherId);

      if (!otherNode || otherNode.entity_type !== 'Person') {
        continue;
      }

      summaries.push({
        entityId: otherNode.entity_id,
        name: otherNode.name ?? null,
        relationshipType: rel.relationship_type,
        direction,
        strength: rel.strength ?? 0.5,
        properties: otherNode.properties ?? null,
      });
    }

    return summaries;
  }

  /**
   * Returns preferences or dislikes for the specified person.
   * Defaults to the user entity and both PREFERS/DISLIKES when no filters provided.
   */
  async getPreferences(
    ownerId: string,
    options: {
      personEntityId?: string;
      relationship?: 'PREFERS' | 'DISLIKES';
      typeFilter?: string;
      limit?: number;
    } = {},
  ): Promise<PreferenceSummary[]> {
    const subjectNode = options.personEntityId
      ? { entity_id: options.personEntityId }
      : await this.graphQuery.getUserEntity(ownerId);

    if (!subjectNode) {
      return [];
    }

    const relationshipTypes = options.relationship ? [options.relationship] : ['PREFERS', 'DISLIKES'];

    const relationships = await this.graphQuery.getRelationships(ownerId, {
      entityIds: [subjectNode.entity_id],
      relationshipTypes,
      direction: 'outbound',
    });

    if (relationships.length === 0) {
      return [];
    }

    const sorted = relationships
      .filter((rel) => relationshipTypes.includes(rel.relationship_type))
      .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
      .slice(0, options.limit ?? relationships.length);

    const conceptIds = Array.from(new Set(sorted.map((rel) => rel.to_entity_id)));
    const conceptNodes = await this.graphQuery.getNodesByIds(ownerId, conceptIds);
    const conceptMap = new Map(conceptNodes.map((node) => [node.entity_id, node]));

    const summaries: PreferenceSummary[] = [];

    for (const rel of sorted) {
      const concept = conceptMap.get(rel.to_entity_id);
      if (!concept) {
        continue;
      }

      const type = this.extractConceptType(concept);
      if (options.typeFilter && type !== options.typeFilter) {
        continue;
      }

      summaries.push({
        entityId: concept.entity_id,
        name: concept.name ?? null,
        type,
        strength: rel.strength ?? 0,
        relationship: rel.relationship_type === 'DISLIKES' ? 'DISLIKES' : 'PREFERS',
        properties: concept.properties ?? null,
      });
    }

    return summaries;
  }

  private extractConceptType(node: GraphNodeEntity): string {
    const propertyType = node.properties?.['type'];
    if (typeof propertyType === 'string' && propertyType.trim().length > 0) {
      return propertyType;
    }

    return node.entity_type ?? 'Concept';
  }
}
