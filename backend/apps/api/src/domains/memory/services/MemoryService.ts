import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';
import { RequestContext } from '@ci/common/types';
import { GraphQueryService } from '@ci/domains/graph';

import { Memory, MemoryLocation, MemoryResponse, MemorySearchParams } from '../types';

type GraphNodeLike = {
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties?: Record<string, unknown> | null;
  linked_table?: string | null;
  linked_id?: string | null;
  created_at: Date;
  updated_at: Date;
  owner_user_id?: string | null;
};

@Injectable()
export class MemoryService {
  private readonly logger = new LoggerService(MemoryService.name);

  private static readonly DEFAULT_ENTITY_TYPES = [
    'Person',
    'Event',
    'Content',
    'Thing',
    'Contact',
    'Place',
    'Location',
    'Document',
    'File',
    'Channel',
    'Video',
    'Communication',
  ];

  constructor(private readonly graphQuery: GraphQueryService) {}

  async findAll(context: RequestContext, params: MemorySearchParams): Promise<MemoryResponse> {
    const userId = this.requireUserId(context);
    this.logger.debug('Finding memories from graph', { userId, params });

    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    try {
      const allowedTypes =
        params.categories && params.categories.length > 0
          ? params.categories
          : MemoryService.DEFAULT_ENTITY_TYPES;

      const graphNodes = await this.graphQuery.getNodes(userId, {
        limit: Math.max(limit * 4, 200),
        offset: 0,
        nameContains: params.query,
      });

      const filteredNodes = graphNodes.filter((node) => allowedTypes.includes(node.entity_type));
      const memories = await Promise.all(filteredNodes.map((node) => this.entityToMemory(node, userId)));

      let filteredMemories = this.applyMemoryFilters(memories, params);
      filteredMemories = this.applySort(filteredMemories);

      const paginated = filteredMemories.slice(offset, offset + limit);

      return {
        data: paginated,
        total: filteredMemories.length,
        limit,
        offset,
      };
    } catch (error) {
      this.logger.error('Failed to load memories', {
        error: error instanceof Error ? error.message : error,
        params,
        userId,
      });
      throw error;
    }
  }

  async findOne(context: RequestContext, id: string): Promise<Memory> {
    const userId = this.requireUserId(context);
    this.logger.debug('Finding memory by id', { id, userId });

    const entity = await this.graphQuery.getNode(userId, id);
    if (!entity) {
      throw new NotFoundException(`Memory with id ${id} not found`);
    }

    return this.entityToMemory(entity, userId);
  }

  async getDebugInfo(context: RequestContext) {
    const userId = this.requireUserId(context);

    const nodes = await this.graphQuery.getNodes(userId, { limit: 1000 });
    const nodeCounts = nodes.reduce<Record<string, number>>((acc, node) => {
      acc[node.entity_type] = (acc[node.entity_type] ?? 0) + 1;

      return acc;
    }, {});

    const relationships = await this.graphQuery.getRelationships(userId, {});
    const relationshipCounts = relationships.reduce<Record<string, number>>((acc, rel) => {
      acc[rel.relationship_type] = (acc[rel.relationship_type] ?? 0) + 1;

      return acc;
    }, {});

    return {
      counts: {
        totalEntities: nodes.length,
        totalRelationships: relationships.length,
        entitiesByType: Object.entries(nodeCounts).map(([type, count]) => ({
          entity_type: type,
          count,
        })),
        relationshipsByType: Object.entries(relationshipCounts).map(([type, count]) => ({
          relationship_type: type,
          count,
        })),
      },
    };
  }

  private applyMemoryFilters(memories: Memory[], params: MemorySearchParams): Memory[] {
    let result = [...memories];

    if (params.query) {
      const query = params.query.toLowerCase();
      result = result.filter((memory) => {
        const matchesTitle = memory.title.toLowerCase().includes(query);
        const matchesDescription = memory.description?.toLowerCase().includes(query) ?? false;
        const matchesTag = memory.tags.some((tag) => tag.toLowerCase().includes(query));

        return matchesTitle || matchesDescription || matchesTag;
      });
    }

    if (params.startDate) {
      const start = new Date(params.startDate).getTime();
      result = result.filter((memory) => new Date(memory.timestamp).getTime() >= start);
    }

    if (params.endDate) {
      const end = new Date(params.endDate).getTime();
      result = result.filter((memory) => new Date(memory.timestamp).getTime() <= end);
    }

    if (params.hasLocation !== undefined) {
      result = result.filter((memory) => (params.hasLocation ? Boolean(memory.location) : !memory.location));
    }

    if (params.excludeCategories && params.excludeCategories.length > 0) {
      const excludes = params.excludeCategories.map((cat) => cat.toLowerCase());
      result = result.filter((memory) => {
        const category = memory.category?.toLowerCase() ?? '';
        const sourceLower =
          typeof memory.metadata?.source === 'string' ? memory.metadata.source.toLowerCase() : '';

        const shouldSkip =
          category.includes('drive') ||
          sourceLower.includes('drive') ||
          excludes.some((exclude) => category.includes(exclude) || sourceLower.includes(exclude));

        return !shouldSkip;
      });
    }

    return result;
  }

  private applySort(memories: Memory[]): Memory[] {
    const now = Date.now();

    return [...memories].sort((a, b) => {
      const aTime = new Date(a.timestamp).getTime();
      const bTime = new Date(b.timestamp).getTime();

      return Math.abs(aTime - now) - Math.abs(bTime - now);
    });
  }

  private async entityToMemory(node: GraphNodeLike, ownerId: string): Promise<Memory> {
    const memoryType = this.mapEntityTypeToMemoryType(node.entity_type);

    const baseLocation = this.extractLocationFromProperties(node);
    const location = baseLocation ?? (await this.getEntityLocation(node.entity_id, ownerId));
    const tags = await this.getEntityTags(node.entity_id, ownerId, node.properties ?? null);
    const timestamp = this.getEntityTimestamp(node);
    const userId = this.getEntityUserId(node);

    return {
      id: node.entity_id,
      type: memoryType,
      title: node.name || 'Untitled',
      description: node.description,
      timestamp,
      category: node.entity_type,
      location,
      tags,
      userId,
      metadata: {
        entityType: node.entity_type,
        linkedTable: node.linked_table,
        linkedId: node.linked_id,
        properties: node.properties,
      },
    };
  }

  private mapEntityTypeToMemoryType(entityType: string): Memory['type'] {
    const map: Record<string, Memory['type']> = {
      Person: 'person',
      Event: 'event',
      Content: 'content',
      Thing: 'thing',
      Contact: 'contact',
      Place: 'other',
      Location: 'other',
      Document: 'content',
      File: 'content',
      Channel: 'other',
      Video: 'content',
      Communication: 'communication',
    };

    return map[entityType] ?? 'other';
  }

  private async getEntityLocation(entityId: string, ownerId: string): Promise<MemoryLocation | undefined> {
    try {
      const relationships = await this.graphQuery.getRelationships(ownerId, {
        entityIds: [entityId],
        relationshipTypes: ['LOCATED_AT', 'HAPPENED_AT', 'AT_LOCATION'],
        direction: 'outbound',
      });

      if (relationships.length > 0) {
        const targetIds = relationships.map((rel) => rel.to_entity_id);
        const [locationEntity] = await this.graphQuery.getNodesByIds(ownerId, targetIds);

        if (locationEntity?.properties) {
          const props = locationEntity.properties as Record<string, unknown>;
          const lat = props.lat || props.latitude;
          const lng = props.lng || props.lon || props.longitude;

          if (typeof lat === 'number' && typeof lng === 'number') {
            return {
              id: locationEntity.entity_id,
              name: locationEntity.name,
              lat,
              lng,
              address: props.address as string | undefined,
            };
          }
        }
      }
    } catch (error) {
      this.logger.error('Error getting entity location', { error, entityId });
    }

    return undefined;
  }

  private async getEntityTags(
    entityId: string,
    ownerId: string,
    properties: Record<string, unknown> | null | undefined,
  ): Promise<string[]> {
    try {
      const tagRelationships = await this.graphQuery.getRelationships(ownerId, {
        entityIds: [entityId],
        relationshipTypes: ['TAGGED_WITH'],
        direction: 'outbound',
      });

      let relationshipTags: string[] = [];
      if (tagRelationships.length > 0) {
        const tagIds = tagRelationships.map((rel) => rel.to_entity_id);
        const tagNodes = await this.graphQuery.getNodesByIds(ownerId, tagIds);
        relationshipTags = tagNodes
          .map((node) => node.name)
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
      }

      const propertyTags: string[] = [];
      if (properties && typeof properties === 'object') {
        const props = properties;
        if (Array.isArray(props.tags)) {
          propertyTags.push(...props.tags.filter((tag): tag is string => typeof tag === 'string'));
        }
      }

      return [...new Set([...relationshipTags, ...propertyTags])];
    } catch (error) {
      this.logger.error('Error getting entity tags', { error, entityId });

      return [];
    }
  }

  private extractLocationFromProperties(node: GraphNodeLike): MemoryLocation | undefined {
    if (!node.properties || typeof node.properties !== 'object') {
      return undefined;
    }

    const props = node.properties as Record<string, unknown>;
    const lat = props.lat || props.latitude;
    const lng = props.lng || props.lon || props.longitude;

    if (typeof lat === 'number' && typeof lng === 'number') {
      return {
        id: `loc-${node.entity_id}`,
        name: node.name,
        lat,
        lng,
        address: props.address as string | undefined,
      };
    }

    return undefined;
  }

  private getEntityTimestamp(node: GraphNodeLike): Date {
    if (node.properties && typeof node.properties === 'object') {
      const props = node.properties as Record<string, unknown>;
      const candidates = [
        'timestamp',
        'start_time',
        'end_time',
        'event_time',
        'created_at',
        'updated_at',
        'last_seen',
      ];

      for (const key of candidates) {
        const value = props[key];
        if (typeof value === 'string' || typeof value === 'number') {
          const date = new Date(value);
          if (!Number.isNaN(date.getTime())) {
            return date;
          }
        }
      }
    }

    return node.updated_at ?? node.created_at;
  }

  private getEntityUserId(node: GraphNodeLike): string {
    if (node.properties && typeof node.properties === 'object') {
      const props = node.properties as Record<string, unknown>;
      const userId = props.user_id || props.owner_id || props.ownerUserId;
      if (typeof userId === 'string') {
        return userId;
      }
    }

    return node.owner_user_id ?? '';
  }

  private requireUserId(context: RequestContext): string {
    if (!context.userId) {
      throw new UnauthorizedException('MemoryService requires an authenticated user context');
    }

    return context.userId;
  }
}
