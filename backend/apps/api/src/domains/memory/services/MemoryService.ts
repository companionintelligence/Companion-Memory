import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Point } from 'typeorm';

import { LoggerService } from '@ci/common/services';
import { RequestContext } from '@ci/common/types';

import { CommunicationEntity } from '../entities/CommunicationEntity';
import { ContentEntity } from '../entities/ContentEntity';
import { EventEntity } from '../entities/EventEntity';
import { GraphNodeEntity } from '../entities/GraphNodeEntity';
import { RelationshipEntity } from '../entities/RelationshipEntity';
import { Memory, MemoryLocation, MemoryResponse, MemorySearchParams } from '../types';

// Type definitions for metadata structures
interface RawEventMetadata {
  htmlLink?: string;
  googleCalendarUrl?: string;
  [key: string]: unknown;
}

interface GeoJSONPoint {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
}

@Injectable()
export class MemoryService {
  private logger = new LoggerService(MemoryService.name);

  constructor(
    @InjectRepository(GraphNodeEntity)
    private entityRepo: Repository<GraphNodeEntity>,
    @InjectRepository(RelationshipEntity)
    private relationshipRepo: Repository<RelationshipEntity>,
    @InjectRepository(EventEntity)
    private eventRepo: Repository<EventEntity>,
    @InjectRepository(ContentEntity)
    private contentRepo: Repository<ContentEntity>,
    @InjectRepository(CommunicationEntity)
    private communicationRepo: Repository<CommunicationEntity>,
  ) {}

  async findAll(context: RequestContext, params: MemorySearchParams): Promise<MemoryResponse> {
    const limit = params.limit || 500;
    const offset = params.offset || 0;

    if (!context.userId) {
      return { data: [], total: 0, limit, offset };
    }

    const [entitiesData, eventsData, contentData, communicationsData] = await Promise.all([
      this.fetchFromEntities(context.userId, params),
      this.fetchFromEvents(context.userId, params),
      this.fetchFromContent(context.userId, params),
      this.fetchFromCommunications(context.userId, params),
    ]);

    const allMemories = [
      ...entitiesData.memories,
      ...eventsData.memories,
      ...contentData.memories,
      ...communicationsData.memories,
    ];

    const now = new Date();
    allMemories.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      const nowTime = now.getTime();

      const distanceA = Math.abs(timeA - nowTime);
      const distanceB = Math.abs(timeB - nowTime);

      return distanceA - distanceB;
    });

    let filteredMemories = allMemories;
    if (params.query) {
      const searchQuery = params.query.toLowerCase();
      filteredMemories = allMemories.filter(
        (memory) =>
          memory.title.toLowerCase().includes(searchQuery) ||
          memory.description?.toLowerCase().includes(searchQuery) ||
          memory.tags.some((tag) => tag.toLowerCase().includes(searchQuery)),
      );
    }

    if (params.excludeCategories && params.excludeCategories.length > 0) {
      filteredMemories = filteredMemories.filter((memory) => {
        const category = memory.category?.toLowerCase() || '';
        const source =
          typeof memory.metadata?.source === 'string' ? memory.metadata.source.toLowerCase() : '';

        const isGoogleDrive =
          category.includes('drive') ||
          category.includes('google drive') ||
          source.includes('drive') ||
          source.includes('google drive') ||
          memory.title?.toLowerCase().includes('drive') ||
          memory.title?.toLowerCase().includes('google drive');

        if (isGoogleDrive) {
          return false;
        }

        const shouldExclude = params.excludeCategories!.some(
          (excludeCat) =>
            category.includes(excludeCat.toLowerCase()) || source.includes(excludeCat.toLowerCase()),
        );

        return !shouldExclude;
      });
    }

    // Filter to include events, communications, and our target entity types
    filteredMemories = filteredMemories.filter((memory) => {
      // Always include events and communications
      if (memory.type === 'event' || memory.type === 'communication') {
        return true;
      }

      // Include our target entity types: Person, Video, File, Channel, Document
      const entityType = memory.metadata?.entityType as string | undefined;
      if (entityType && ['Person', 'Video', 'File', 'Channel', 'Document'].includes(entityType)) {
        return true;
      }

      // Filter out everything else
      return false;
    });

    if (params.hasLocation !== undefined) {
      filteredMemories = filteredMemories.filter((memory) =>
        params.hasLocation ? !!memory.location : !memory.location,
      );
    }

    const paginatedMemories = filteredMemories.slice(offset, offset + limit);
    const total = filteredMemories.length;

    return {
      data: paginatedMemories,
      total,
      limit,
      offset,
    };
  }

  // Fetch memories from entities table
  private async fetchFromEntities(
    userId: string,
    params: MemorySearchParams,
  ): Promise<{ memories: Memory[]; count: number }> {
    try {
      // Filter for specific entity types that should appear in timeline
      // NOTE: We exclude 'Event' because events are fetched from the events table
      const timelineEntityTypes = ['Person', 'Video', 'File', 'Channel', 'Document'];

      let queryBuilder = this.entityRepo
        .createQueryBuilder('entity')
        .where('entity.is_active = true')
        .andWhere('entity.is_archived = false')
        .andWhere('entity.owner_user_id = :userId', { userId })
        .andWhere('entity.entity_type IN (:...types)', { types: timelineEntityTypes });

      // Note: Date filtering uses created_at/updated_at, but actual timeline sorting
      // uses entity-specific timestamp fields (last_seen, modified_time, etc.)
      // This is intentional to cast a wide net in the query, then sort by specific fields
      if (params.startDate) {
        queryBuilder = queryBuilder.andWhere(
          '(entity.created_at >= :startDate OR entity.updated_at >= :startDate)',
          { startDate: params.startDate },
        );
      }

      if (params.endDate) {
        queryBuilder = queryBuilder.andWhere(
          '(entity.created_at <= :endDate OR entity.updated_at <= :endDate)',
          { endDate: params.endDate },
        );
      }

      queryBuilder = queryBuilder.orderBy('entity.updated_at', 'DESC').limit(500);

      const entities = await queryBuilder.getMany();
      const memories = await Promise.all(entities.map((entity) => this.entityToMemory(entity)));

      return { memories, count: memories.length };
    } catch (error) {
      this.logger.error('Error fetching entities for timeline', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });

      return { memories: [], count: 0 };
    }
  }

  // Fetch memories from events table
  private async fetchFromEvents(
    userId: string,
    params: MemorySearchParams,
  ): Promise<{ memories: Memory[]; count: number }> {
    try {
      let queryBuilder = this.eventRepo
        .createQueryBuilder('event')
        .leftJoinAndSelect('event.user', 'user')
        .addSelect('ST_AsGeoJSON(event.location_coordinates)', 'location_geojson')
        .where('user.id = :userId', { userId });

      if (params.startDate) {
        queryBuilder = queryBuilder.andWhere('event.start_time >= :startDate', {
          startDate: params.startDate,
        });
      }

      if (params.endDate) {
        queryBuilder = queryBuilder.andWhere('event.start_time <= :endDate', {
          endDate: params.endDate,
        });
      }

      // Order by proximity to current time, prioritizing recent events
      queryBuilder = queryBuilder
        .orderBy('ABS(EXTRACT(EPOCH FROM (event.start_time - NOW())))', 'ASC')
        .limit(500);

      const results = await queryBuilder.getRawAndEntities();
      const memories = await Promise.all(
        results.entities.map((event, index) => {
          // Attach the parsed GeoJSON to the event entity
          const geoJsonStr = results.raw[index]?.location_geojson;
          if (geoJsonStr && typeof geoJsonStr === 'string') {
            try {
              event.location_coordinates = JSON.parse(geoJsonStr) as Point;
            } catch (e) {
              console.error('Error parsing location coordinates', e);
            }
          }

          return this.eventToMemoryAsync(event);
        }),
      );

      return { memories, count: memories.length };
    } catch {
      return { memories: [], count: 0 };
    }
  }

  // Fetch memories from content table
  private async fetchFromContent(
    userId: string,
    params: MemorySearchParams,
  ): Promise<{ memories: Memory[]; count: number }> {
    try {
      let queryBuilder = this.contentRepo
        .createQueryBuilder('content')
        .leftJoinAndSelect('content.user', 'user')
        .where('user.id = :userId', { userId });

      if (params.startDate) {
        queryBuilder = queryBuilder.andWhere('content.created_at >= :startDate', {
          startDate: params.startDate,
        });
      }

      if (params.endDate) {
        queryBuilder = queryBuilder.andWhere('content.created_at <= :endDate', {
          endDate: params.endDate,
        });
      }

      queryBuilder = queryBuilder.orderBy('content.created_at', 'DESC').limit(500);

      const contentItems = await queryBuilder.getMany();
      const memories = contentItems.map((content) => this.contentToMemory(content));

      return { memories, count: memories.length };
    } catch {
      return { memories: [], count: 0 };
    }
  }

  // Fetch memories from communications table
  private async fetchFromCommunications(
    userId: string,
    params: MemorySearchParams,
  ): Promise<{ memories: Memory[]; count: number }> {
    try {
      let queryBuilder = this.communicationRepo
        .createQueryBuilder('comm')
        .where('comm.user_id = :userId', { userId });

      if (params.startDate) {
        queryBuilder = queryBuilder.andWhere('comm.time >= :startDate', {
          startDate: params.startDate,
        });
      }

      if (params.endDate) {
        queryBuilder = queryBuilder.andWhere('comm.time <= :endDate', {
          endDate: params.endDate,
        });
      }

      queryBuilder = queryBuilder.orderBy('comm.time', 'DESC').limit(500);

      const communications = await queryBuilder.getMany();
      const memories = communications.map((comm) => this.communicationToMemory(comm));

      return { memories, count: memories.length };
    } catch {
      return { memories: [], count: 0 };
    }
  }

  // Convert EventEntity to Memory
  private async eventToMemoryAsync(event: EventEntity): Promise<Memory> {
    // Extract source link from metadata
    const metadata = event.metadata || {};
    const rawEvent = (metadata.rawEvent as RawEventMetadata | undefined) || ({} as RawEventMetadata);
    const sourceLink = (metadata.googleCalendarUrl as string | undefined) || rawEvent.htmlLink || undefined;

    // Extract location with coordinates
    let location: Memory['location'] = undefined;
    if (event.location_name || event.location_coordinates || event.location_entity_id) {
      // Try to get coordinates from location_coordinates field first
      const coords = this.parseLocationCoordinates(event.location_coordinates);

      // If no coordinates but we have a location_entity_id, look up the location entity
      let entityCoords = coords;
      if (!entityCoords && event.location_entity_id) {
        const locationEntity = await this.entityRepo.findOne({
          where: { entity_id: event.location_entity_id },
        });

        if (locationEntity && locationEntity.properties) {
          const props = locationEntity.properties as Record<string, unknown>;
          const lat = props.lat || props.latitude;
          const lng = props.lng || props.lon || props.longitude;

          if (lat && lng && typeof lat === 'number' && typeof lng === 'number') {
            entityCoords = { lat, lng };
          }
        }
      }

      // Only create location object if we have valid coordinates
      if (entityCoords) {
        location = {
          id: event.location_entity_id || `loc-${event.id}`,
          name: event.location_name,
          lat: entityCoords.lat,
          lng: entityCoords.lng,
        };
      }
    }

    return {
      id: event.id,
      type: 'event',
      title: event.title || 'Untitled Event',
      description: event.description,
      timestamp: event.start_time,
      category: event.category || 'Event',
      location,
      tags: event.tags || [],
      userId: event.user?.id || '',
      sourceLink: sourceLink,
      metadata: {
        eventType: event.event_type ?? undefined,
        category: event.category ?? undefined,
        source: event.source_system ?? undefined,
        ...event.metadata,
      },
    };
  }

  // Synchronous wrapper for backwards compatibility (coordinates only)
  private eventToMemory(event: EventEntity): Memory {
    // Extract source link from metadata
    const metadata = event.metadata || {};
    const rawEvent = (metadata.rawEvent as RawEventMetadata | undefined) || ({} as RawEventMetadata);
    const sourceLink = (metadata.googleCalendarUrl as string | undefined) || rawEvent.htmlLink || undefined;

    // Extract location with coordinates (synchronous version - no entity lookup)
    let location: Memory['location'] = undefined;
    if (event.location_name || event.location_coordinates) {
      const coords = this.parseLocationCoordinates(event.location_coordinates);
      // Only create location object if we have valid coordinates
      if (coords) {
        location = {
          id: event.location_entity_id || `loc-${event.id}`,
          name: event.location_name,
          lat: coords.lat,
          lng: coords.lng,
        };
      }
    }

    return {
      id: event.id,
      type: 'event',
      title: event.title || 'Untitled Event',
      description: event.description,
      timestamp: event.start_time,
      category: event.category || 'Event',
      location,
      tags: event.tags || [],
      userId: event.user?.id || '',
      sourceLink: sourceLink,
      metadata: {
        eventType: event.event_type ?? undefined,
        category: event.category ?? undefined,
        source: event.source_system ?? undefined,
        ...event.metadata,
      },
    };
  }

  // Helper method to parse PostGIS GEOGRAPHY(POINT) format
  private parseLocationCoordinates(coordinates: Point | string | null): { lat: number; lng: number } | null {
    if (!coordinates) {
      return null;
    }

    if (typeof coordinates === 'string') {
      // Check if it's a WKB hex string (starts with hex digits)
      if (/^[0-9A-Fa-f]+$/.test(coordinates) && coordinates.length > 20) {
        // It's likely a WKB hex string from PostGIS
        // Log it and return null for now - TypeORM should handle this automatically
        this.logger.warn('Received WKB hex string for location coordinates', {
          wkbLength: coordinates.length,
          wkbPreview: coordinates.substring(0, 20),
        });

        return null;
      }

      // Try to parse WKT format: POINT(lng lat)
      const pointMatch = coordinates.match(/POINT\s*\(\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s*\)/i);
      if (pointMatch) {
        const lng = parseFloat(pointMatch[1]);
        const lat = parseFloat(pointMatch[2]);
        if (!isNaN(lat) && !isNaN(lng)) {
          return { lat, lng };
        }
      }
    }

    if (typeof coordinates === 'object') {
      const geoJson = coordinates as GeoJSONPoint;
      if (geoJson.type === 'Point' && Array.isArray(geoJson.coordinates)) {
        const [lng, lat] = geoJson.coordinates;
        if (!isNaN(lat) && !isNaN(lng)) {
          return { lat, lng };
        }
      }
    }

    return null;
  }

  // Convert ContentEntity to Memory
  private contentToMemory(content: ContentEntity): Memory {
    return {
      id: content.id,
      type: 'content',
      title: content.title || 'Untitled File',
      description: content.text,
      timestamp: content.created_at,
      category: 'File',
      tags: [],
      userId: content.user?.id || '',
      metadata: {
        contentType: content.type,
        mimetype: content.mimetype ?? undefined,
        url: content.url ?? undefined,
        externalId: content.external_id ?? undefined,
      },
    };
  }

  // Convert CommunicationEntity to Memory
  private communicationToMemory(comm: CommunicationEntity): Memory {
    return {
      id: `${comm.user_id}-${comm.time.getTime()}-${comm.communication_type}`,
      type: 'communication',
      title: comm.subject || `${comm.communication_type} Communication`,
      description: comm.summary || comm.content.substring(0, 200) || null,
      timestamp: comm.time,
      category: comm.category || 'Communication',
      tags: comm.tags || [],
      userId: comm.user_id,
      metadata: {
        communicationType: comm.communication_type,
        direction: comm.direction,
        participantsMetadata: comm.participants_metadata,
        threadId: comm.thread_id ?? undefined,
      },
    };
  }

  async findOne(context: RequestContext, id: string): Promise<Memory> {
    const entity = await this.entityRepo.findOne({
      where: { entity_id: id, is_active: true },
    });

    if (!entity) {
      throw new NotFoundException(`Memory with id ${id} not found`);
    }

    return this.entityToMemory(entity);
  }

  private async entityToMemory(entity: GraphNodeEntity): Promise<Memory> {
    // Map entity types to memory types
    const memoryType = this.mapEntityTypeToMemoryType(entity.entity_type);

    // Get location if entity has location relationships
    const location = await this.getEntityLocation(entity);

    // Extract tags from properties or relationships
    const tags = await this.getEntityTags(entity);

    // Get timestamp - prefer event time from properties, fallback to created_at
    const timestamp = this.getEntityTimestamp(entity);

    // Extract user ID from properties or linked data
    const userId = this.getEntityUserId(entity);

    const relationships = await this.getEntityRelationships(entity);

    const memory: Memory = {
      id: entity.entity_id,
      type: memoryType,
      title: entity.name || 'Untitled',
      description: entity.description,
      timestamp,
      category: entity.entity_type,
      location,
      tags,
      userId,
      metadata: {
        entityType: entity.entity_type,
        linkedTable: entity.linked_table,
        linkedId: entity.linked_id,
        properties: entity.properties,
        relationships, // Include relationship information
      },
    };

    return memory;
  }

  private mapEntityTypeToMemoryType(entityType: string): Memory['type'] {
    const typeMap: Record<string, Memory['type']> = {
      Person: 'person',
      Event: 'event',
      Content: 'content',
      Thing: 'thing',
      Object: 'thing',
      Contact: 'contact',
      Place: 'place',
      Location: 'place',
      Concept: 'concept',
      Goal: 'other',
      Video: 'content',
      File: 'content',
      Document: 'content',
      Channel: 'other',
    };

    return typeMap[entityType] || 'other';
  }

  private async getEntityRelationships(entity: GraphNodeEntity): Promise<
    Array<{
      type: string;
      targetId: string;
      targetName: string;
      targetType: string;
      direction: 'outgoing' | 'incoming';
    }>
  > {
    try {
      // Get outgoing relationships
      const outgoing = await this.relationshipRepo
        .createQueryBuilder('rel')
        .leftJoinAndSelect('rel.to_entity', 'target')
        .where('rel.from_entity_id = :entityId', { entityId: entity.entity_id })
        .andWhere('rel.is_active = true')
        .limit(20) // Limit to avoid too much data
        .getMany();

      // Get incoming relationships
      const incoming = await this.relationshipRepo
        .createQueryBuilder('rel')
        .leftJoinAndSelect('rel.from_entity', 'source')
        .where('rel.to_entity_id = :entityId', { entityId: entity.entity_id })
        .andWhere('rel.is_active = true')
        .limit(20) // Limit to avoid too much data
        .getMany();

      const relationships = [
        ...outgoing.map((rel) => ({
          type: rel.relationship_type,
          targetId: rel.to_entity?.entity_id || '',
          targetName: rel.to_entity?.name || 'Unknown',
          targetType: rel.to_entity?.entity_type || 'Unknown',
          direction: 'outgoing' as const,
        })),
        ...incoming.map((rel) => ({
          type: rel.relationship_type,
          targetId: rel.from_entity?.entity_id || '',
          targetName: rel.from_entity?.name || 'Unknown',
          targetType: rel.from_entity?.entity_type || 'Unknown',
          direction: 'incoming' as const,
        })),
      ];

      return relationships;
    } catch {
      return [];
    }
  }

  private async getEntityLocation(entity: GraphNodeEntity): Promise<MemoryLocation | undefined> {
    const locationRels = await this.relationshipRepo
      .createQueryBuilder('rel')
      .leftJoinAndSelect('rel.to_entity', 'location')
      .where('rel.from_entity_id = :entityId', { entityId: entity.entity_id })
      .andWhere('rel.relationship_type IN (:...types)', {
        types: ['LOCATED_AT', 'HAPPENED_AT', 'AT_LOCATION'],
      })
      .andWhere('rel.is_active = true')
      .andWhere('location.entity_type IN (:...locationTypes)', {
        locationTypes: ['Location', 'Place'],
      })
      .getMany();

    if (locationRels.length > 0) {
      const locationEntity = locationRels[0].to_entity;
      if (locationEntity?.properties) {
        const props = locationEntity.properties as Record<string, unknown>;

        const lat = props.lat || props.latitude;
        const lng = props.lng || props.lon || props.longitude;

        if (lat && lng && typeof lat === 'number' && typeof lng === 'number') {
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

    if (entity.properties) {
      const props = entity.properties as Record<string, unknown>;
      const lat = props.lat || props.latitude;
      const lng = props.lng || props.lon || props.longitude;

      if (lat && lng && typeof lat === 'number' && typeof lng === 'number') {
        return {
          id: `loc-${entity.entity_id}`,
          name: entity.name,
          lat,
          lng,
          address: props.address as string | undefined,
        };
      }
    }

    return undefined;
  }

  private async getEntityTags(entity: GraphNodeEntity): Promise<string[]> {
    try {
      // Look for tag relationships
      const tagRels = await this.relationshipRepo
        .createQueryBuilder('rel')
        .leftJoinAndSelect('rel.to_entity', 'tag')
        .where('rel.from_entity_id = :entityId', { entityId: entity.entity_id })
        .andWhere('rel.relationship_type = :type', { type: 'TAGGED_WITH' })
        .andWhere('rel.is_active = true')
        .andWhere('tag.entity_type = :tagType', { tagType: 'Tag' })
        .getMany();

      const relationshipTags = tagRels
        .map((rel) => rel.to_entity?.name)
        .filter((name): name is string => !!name);

      // Also check properties for tags
      const propertyTags: string[] = [];
      if (entity.properties && typeof entity.properties === 'object') {
        const props = entity.properties as Record<string, unknown>;
        if (Array.isArray(props.tags)) {
          propertyTags.push(...props.tags.filter((tag): tag is string => typeof tag === 'string'));
        }
      }

      // Combine and deduplicate
      return [...new Set([...relationshipTags, ...propertyTags])];
    } catch {
      return [];
    }
  }

  private getEntityTimestamp(entity: GraphNodeEntity): Date {
    // Use entity-type specific timestamp fields
    const entityType = entity.entity_type;

    if (entity.properties && typeof entity.properties === 'object') {
      const props = entity.properties as Record<string, unknown>;

      // Person: look for most recent last_seen from source_data objects (email_data, calendar_data, etc.)
      if (entityType === 'Person') {
        let mostRecentLastSeen: Date | null = null;

        // Check all source_data objects for last_seen timestamps
        for (const [key, value] of Object.entries(props)) {
          if (key.endsWith('_data') && value && typeof value === 'object') {
            const sourceData = value as Record<string, unknown>;
            if (sourceData.last_seen && typeof sourceData.last_seen === 'string') {
              const parsed = new Date(sourceData.last_seen);
              if (!isNaN(parsed.getTime())) {
                if (!mostRecentLastSeen || parsed > mostRecentLastSeen) {
                  mostRecentLastSeen = parsed;
                }
              }
            }
          }
        }

        if (mostRecentLastSeen) {
          return mostRecentLastSeen;
        }
      }

      // Document and File: use modified_time
      if ((entityType === 'Document' || entityType === 'File') && props.modified_time) {
        const parsed = new Date(props.modified_time as string);
        if (!isNaN(parsed.getTime())) {
          return parsed;
        }
      }

      // Try different timestamp field names for other types
      const timeFields = ['start_time', 'timestamp', 'date', 'created_date'];
      for (const field of timeFields) {
        const timeValue = props[field];
        if (timeValue && typeof timeValue === 'string') {
          const parsed = new Date(timeValue);
          if (!isNaN(parsed.getTime())) {
            return parsed;
          }
        }
      }
    }

    // Video and Channel: use updated_at if available, otherwise created_at
    if (entityType === 'Video' || entityType === 'Channel') {
      if (entity.updated_at) {
        return entity.updated_at;
      }
    }

    // Fallback to entity created_at
    return entity.created_at;
  }

  private getEntityUserId(entity: GraphNodeEntity): string {
    // First, try the owner_user_id column
    if (entity.owner_user_id) {
      return entity.owner_user_id;
    }

    // Fallback: Try to get user ID from properties
    if (entity.properties && typeof entity.properties === 'object') {
      const props = entity.properties as Record<string, unknown>;
      const userId = props.user_id || props.userId;
      if (userId && typeof userId === 'string') {
        return userId;
      }
    }

    // Return empty string if no user ID found
    return '';
  }

  async getDebugInfo() {
    const entityCounts = await this.entityRepo
      .createQueryBuilder('entity')
      .select('entity.entity_type, COUNT(*) as count')
      .where('entity.is_active = true')
      .groupBy('entity.entity_type')
      .getRawMany();

    const relationshipCounts = await this.relationshipRepo
      .createQueryBuilder('rel')
      .select('rel.relationship_type, COUNT(*) as count')
      .where('rel.is_active = true')
      .groupBy('rel.relationship_type')
      .getRawMany();

    const totalEntities = await this.entityRepo.count({ where: { is_active: true } });
    const totalRelationships = await this.relationshipRepo.count({ where: { is_active: true } });

    return {
      counts: {
        totalEntities,
        totalRelationships,
        entitiesByType: entityCounts,
        relationshipsByType: relationshipCounts,
      },
    };
  }
}
