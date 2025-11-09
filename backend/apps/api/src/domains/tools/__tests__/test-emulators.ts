/**
 * Test emulators/mocks for testing tools
 * Provides mock implementations of GraphQueryService and GraphReadService
 */

import type { GraphNodeEntity, RelationshipEntity } from '@ci/domains/memory';

/**
 * Mock implementation of GraphQueryService for testing
 */
export class MockGraphQueryService {
  private userEntities: Map<string, GraphNodeEntity> = new Map();

  private nodes: Map<string, GraphNodeEntity> = new Map();

  private relationships: RelationshipEntity[] = [];

  /**
   * Set up a mock user entity
   */
  setUserEntity(ownerId: string, entity: GraphNodeEntity): void {
    this.userEntities.set(ownerId, entity);
  }

  /**
   * Add a mock node
   */
  addNode(node: GraphNodeEntity): void {
    this.nodes.set(node.entity_id, node);
  }

  /**
   * Add a mock relationship
   */
  addRelationship(relationship: RelationshipEntity): void {
    this.relationships.push(relationship);
  }

  /**
   * Mock getUserEntity method
   */
  async getUserEntity(ownerId: string): Promise<GraphNodeEntity | null> {
    return this.userEntities.get(ownerId) ?? null;
  }

  /**
   * Mock getNode method
   */
  async getNode(ownerId: string, entityId: string): Promise<GraphNodeEntity | null> {
    return this.nodes.get(entityId) ?? null;
  }

  /**
   * Mock getNodesByIds method
   */
  async getNodesByIds(ownerId: string, entityIds: string[]): Promise<GraphNodeEntity[]> {
    return entityIds
      .map((id) => this.nodes.get(id))
      .filter((node): node is GraphNodeEntity => node !== undefined);
  }

  /**
   * Mock getRelationships method
   */
  async getRelationships(
    ownerId: string,
    options: {
      entityIds?: string[];
      relationshipTypes?: string[];
      direction?: 'inbound' | 'outbound' | 'both';
    },
  ): Promise<RelationshipEntity[]> {
    let filtered = this.relationships;

    if (options.entityIds && options.entityIds.length > 0) {
      filtered = filtered.filter((rel) => {
        if (options.direction === 'outbound') {
          return options.entityIds!.includes(rel.from_entity_id);
        } else if (options.direction === 'inbound') {
          return options.entityIds!.includes(rel.to_entity_id);
        } else {
          // both
          return (
            options.entityIds!.includes(rel.from_entity_id) || options.entityIds!.includes(rel.to_entity_id)
          );
        }
      });
    }

    if (options.relationshipTypes && options.relationshipTypes.length > 0) {
      filtered = filtered.filter((rel) => options.relationshipTypes!.includes(rel.relationship_type));
    }

    return filtered;
  }

  /**
   * Reset all mock data
   */
  reset(): void {
    this.userEntities.clear();
    this.nodes.clear();
    this.relationships = [];
  }
}

/**
 * Mock implementation of GraphReadService for testing
 * Implements the same interface as GraphReadService for type-safe testing
 */
export class MockGraphReadService {
  constructor(private readonly graphQuery: MockGraphQueryService) {}

  // Type-safe mock that matches GraphQueryService interface
  get graphQueryService(): MockGraphQueryService {
    return this.graphQuery;
  }

  /**
   * Mock getNode method - delegates to graphQuery
   */
  async getNode(ownerId: string, entityId: string): Promise<GraphNodeEntity | null> {
    return this.graphQuery.getNode(ownerId, entityId);
  }

  /**
   * Mock getFamilyMembers method
   */
  async getFamilyMembers(
    ownerId: string,
    options: {
      relationshipTypes?: string[];
      personEntityId?: string;
    } = {},
  ): Promise<
    Array<{
      entityId: string;
      name: string | null;
      relationshipType: string;
      direction: 'outbound' | 'inbound';
      strength: number;
      properties?: Record<string, unknown>;
    }>
  > {
    const DEFAULT_FAMILY_RELATIONSHIPS = [
      'SPOUSE',
      'PARTNER',
      'ROMANTIC_PARTNER',
      'PARENT_OF',
      'CHILD_OF',
      'SIBLING_OF',
      'FAMILY_MEMBER',
    ];

    const subjectNode = options.personEntityId
      ? { entity_id: options.personEntityId }
      : await this.graphQuery.getUserEntity(ownerId);

    if (!subjectNode) {
      return [];
    }

    const relationshipTypes =
      options.relationshipTypes && options.relationshipTypes.length > 0
        ? options.relationshipTypes
        : DEFAULT_FAMILY_RELATIONSHIPS;

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

    const summaries: Array<{
      entityId: string;
      name: string | null;
      relationshipType: string;
      direction: 'outbound' | 'inbound';
      strength: number;
      properties?: Record<string, unknown>;
    }> = [];

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
        properties: otherNode.properties ?? undefined,
      });
    }

    return summaries;
  }

  /**
   * Mock getPreferences method
   */
  async getPreferences(
    ownerId: string,
    options: {
      personEntityId?: string;
      relationship?: 'PREFERS' | 'DISLIKES';
      typeFilter?: string;
      limit?: number;
    } = {},
  ): Promise<
    Array<{
      entityId: string;
      name: string | null;
      type: string;
      strength: number;
      relationship: 'PREFERS' | 'DISLIKES';
      properties?: Record<string, unknown> | null;
    }>
  > {
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

    const summaries: Array<{
      entityId: string;
      name: string | null;
      type: string;
      strength: number;
      relationship: 'PREFERS' | 'DISLIKES';
      properties?: Record<string, unknown> | null;
    }> = [];

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
