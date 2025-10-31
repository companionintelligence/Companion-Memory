import { Readable } from 'node:stream';

import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Point } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/services';
import { RequestContext } from '@ci/common/types';
import { BrowserActivityEntity } from '@ci/domains/browser-activity';
import { EventPayloads, Events, OnEvent } from '@ci/domains/events';
import { FileService, type File } from '@ci/domains/files';
import { GraphQueryService } from '@ci/domains/graph';

import { CommunicationEntity } from '../entities/CommunicationEntity';
import { ContentEntity } from '../entities/ContentEntity';
import { EventEntity } from '../entities/EventEntity';
import { FileEntity } from '../entities/FileEntity';
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

type FileUploadFields = {
  userId: string;
  fileId?: string;
  externalId?: string;
  fileName: string;
  mimeType: string;
  size: number;
  buffer?: Buffer;
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
    'Browser',
  ];

  constructor(
    private readonly graphQuery: GraphQueryService,
    private readonly fileService: FileService,
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    @InjectRepository(CommunicationEntity)
    private readonly communicationRepository: Repository<CommunicationEntity>,
    @InjectRepository(ContentEntity)
    private readonly contentRepository: Repository<ContentEntity>,
    @InjectRepository(BrowserActivityEntity)
    private readonly browserActivityRepository: Repository<BrowserActivityEntity>,
  ) {}

  /**
   * Get memories from specific entity tables based on entity type
   */
  private async getMemoriesFromSpecificTables(
    userId: string,
    entityTypes: string[],
    params: MemorySearchParams,
  ): Promise<Memory[]> {
    this.logger.debug('getMemoriesFromSpecificTables called', { userId, entityTypes, params });
    const memories: Memory[] = [];

    // Handle Event entities
    if (entityTypes.includes('Event')) {
      this.logger.debug('Querying events table');
      const eventMemories = await this.getEventMemories(userId, params);
      memories.push(...eventMemories);
      this.logger.debug('Events found', { count: eventMemories.length });
    }

    // Handle Communication entities
    if (entityTypes.includes('Communication')) {
      this.logger.debug('Querying communications table');
      const communicationMemories = await this.getCommunicationMemories(userId, params);
      memories.push(...communicationMemories);
      this.logger.debug('Communications found', { count: communicationMemories.length });
    }

    // Handle Content entities
    if (entityTypes.includes('Content')) {
      this.logger.debug('Querying content table');
      const contentMemories = await this.getContentMemories(userId, params);
      memories.push(...contentMemories);
      this.logger.debug('Content found', { count: contentMemories.length });
    }

    // Handle BrowserActivity entities
    if (entityTypes.includes('Browser')) {
      this.logger.debug('Querying browser activity table');
      const browserActivityMemories = await this.getBrowserActivityMemories(userId, params);
      memories.push(...browserActivityMemories);
      this.logger.debug('Browser activity found', { count: browserActivityMemories.length });
    }

    this.logger.debug('getMemoriesFromSpecificTables returning', { totalCount: memories.length });

    return memories;
  }

  /**
   * Get memories from events table
   */
  private async getEventMemories(userId: string, params: MemorySearchParams): Promise<Memory[]> {
    this.logger.debug('getEventMemories called', { userId, params });

    // Now try the full query with user relationship
    let query = this.eventRepository
      .createQueryBuilder('event')
      .leftJoin('event.user', 'user')
      .where('user.id = :userId', { userId })
      .andWhere('event.is_deleted = false');

    // Apply search query
    if (params.query) {
      query = query.andWhere('(event.title ILIKE :query OR event.description ILIKE :query)', {
        query: `%${params.query}%`,
      });
    }

    // Apply date filters
    if (params.startDate) {
      query = query.andWhere('event.start_time >= :startDate', { startDate: params.startDate });
    }

    if (params.endDate) {
      query = query.andWhere('event.start_time <= :endDate', { endDate: params.endDate });
    }

    // Apply category filters
    if (params.categories && params.categories.length > 0) {
      query = query.andWhere('event.category IN (:...categories)', { categories: params.categories });
    }

    if (params.excludeCategories && params.excludeCategories.length > 0) {
      query = query.andWhere('event.category NOT IN (:...excludeCategories)', {
        excludeCategories: params.excludeCategories,
      });
    }

    // Apply location filter
    if (params.hasLocation) {
      query = query.andWhere('event.location_coordinates IS NOT NULL');
    }

    query = query.orderBy('event.start_time', 'DESC');

    const events = await query.getMany();
    const memories = events.map((event) => this.eventToMemory(event));

    return memories;
  }

  /**
   * Get memories from communications table
   */
  private async getCommunicationMemories(userId: string, params: MemorySearchParams): Promise<Memory[]> {
    this.logger.debug('getCommunicationMemories called', { userId, params });

    try {
      let query = this.communicationRepository
        .createQueryBuilder('communication')
        .where('communication.user_id = :userId', { userId })
        .andWhere('communication.is_archived = false');

      // Apply search query
      if (params.query) {
        query = query.andWhere('(communication.subject ILIKE :query OR communication.content ILIKE :query)', {
          query: `%${params.query}%`,
        });
      }

      // Apply date filters
      if (params.startDate) {
        query = query.andWhere('communication.time >= :startDate', { startDate: params.startDate });
      }

      if (params.endDate) {
        query = query.andWhere('communication.time <= :endDate', { endDate: params.endDate });
      }

      // Apply category filters
      if (params.categories && params.categories.length > 0) {
        query = query.andWhere('communication.category IN (:...categories)', {
          categories: params.categories,
        });
      }

      if (params.excludeCategories && params.excludeCategories.length > 0) {
        query = query.andWhere('communication.category NOT IN (:...excludeCategories)', {
          excludeCategories: params.excludeCategories,
        });
      }

      query = query.orderBy('communication.time', 'DESC').limit(100);

      const communications = await query.getMany();
      const memories = communications.map((comm: CommunicationEntity) => this.communicationToMemory(comm));

      return memories;
    } catch (error) {
      this.logger.error('Error in getCommunicationMemories', {
        error: error instanceof Error ? error.message : error,
        userId,
        params,
      });

      return [];
    }
  }

  /**
   * Get memories from content table
   */
  private async getContentMemories(userId: string, params: MemorySearchParams): Promise<Memory[]> {
    let query = this.contentRepository
      .createQueryBuilder('content')
      .leftJoin('content.user', 'user')
      .where('user.id = :userId', { userId });

    // Apply search query
    if (params.query) {
      query = query.andWhere('(content.title ILIKE :query OR content.text ILIKE :query)', {
        query: `%${params.query}%`,
      });
    }

    // Apply date filters
    if (params.startDate) {
      query = query.andWhere('content.created_at >= :startDate', { startDate: params.startDate });
    }

    if (params.endDate) {
      query = query.andWhere('content.created_at <= :endDate', { endDate: params.endDate });
    }

    // Apply category filters
    if (params.categories && params.categories.length > 0) {
      query = query.andWhere('content.type IN (:...categories)', { categories: params.categories });
    }

    if (params.excludeCategories && params.excludeCategories.length > 0) {
      query = query.andWhere('content.type NOT IN (:...excludeCategories)', {
        excludeCategories: params.excludeCategories,
      });
    }

    query = query.orderBy('content.created_at', 'DESC');

    const contents = await query.getMany();

    return contents.map((content) => this.contentToMemory(content));
  }

  async findAll(context: RequestContext, params: MemorySearchParams): Promise<MemoryResponse> {
    const userId = this.requireUserId(context);
    this.logger.debug('Finding memories from graph and specific tables', { userId, params });

    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    try {
      const allowedTypes =
        params.categories && params.categories.length > 0
          ? params.categories
          : MemoryService.DEFAULT_ENTITY_TYPES;

      // Apply exclusions if specified
      const finalAllowedTypes =
        params.excludeCategories && params.excludeCategories.length > 0
          ? allowedTypes.filter((type) => !params.excludeCategories!.includes(type))
          : allowedTypes;

      this.logger.debug('MemoryService.findAll - Entity type filtering', {
        allowedTypes,
        excludeCategories: params.excludeCategories,
        finalAllowedTypes,
      });

      // Separate entity types into graph-based and table-based
      const graphBasedTypes = finalAllowedTypes.filter(
        (type) => !['Event', 'Communication', 'Content', 'Browser'].includes(type),
      );
      const tableBasedTypes = finalAllowedTypes.filter((type) =>
        ['Event', 'Communication', 'Content', 'Browser'].includes(type),
      );

      this.logger.debug('MemoryService.findAll - Type separation', {
        graphBasedTypes,
        tableBasedTypes,
      });

      const allMemories: Memory[] = [];

      // Get memories from graph nodes (for non-table entities)
      if (graphBasedTypes.length > 0) {
        this.logger.debug('MemoryService.findAll - Querying graph nodes', { graphBasedTypes });
        const graphNodes = await this.graphQuery.getNodes(userId, {
          limit: Math.max(limit * 4, 200),
          offset: 0,
          nameContains: params.query,
        });

        const filteredNodes = graphNodes.filter((node) => graphBasedTypes.includes(node.entity_type));
        const graphMemories = await Promise.all(
          filteredNodes.map((node) => this.entityToMemory(node, userId)),
        );
        allMemories.push(...graphMemories);
        this.logger.debug('MemoryService.findAll - Graph memories found', { count: graphMemories.length });
      }

      // Get memories from specific tables
      if (tableBasedTypes.length > 0) {
        this.logger.debug('MemoryService.findAll - Querying specific tables', { tableBasedTypes });
        const tableMemories = await this.getMemoriesFromSpecificTables(userId, tableBasedTypes, params);
        allMemories.push(...tableMemories);
        this.logger.debug('MemoryService.findAll - Table memories found', { count: tableMemories.length });
      } else {
        this.logger.debug('MemoryService.findAll - No table-based types to query', {
          tableBasedTypes,
          finalAllowedTypes,
          excludeCategories: params.excludeCategories,
        });
      }

      let filteredMemories = this.applyMemoryFilters(allMemories, params);
      filteredMemories = this.applySort(filteredMemories);

      const paginated = filteredMemories.slice(offset, offset + limit);

      this.logger.debug('MemoryService.findAll - Final results', {
        totalMemories: allMemories.length,
        filteredMemories: filteredMemories.length,
        paginated: paginated.length,
      });

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

    // Note: excludeCategories filtering is handled in findAll method for entity type filtering
    // This method only handles content-based filtering (query, dates, location)

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
      Browser: 'browser',
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

  async createFile(details: FileUploadFields): Promise<{ file: File; entity: FileEntity }> {
    const { userId, fileName, mimeType, size, buffer } = details;
    const file = {
      fieldname: 'attachment', //Multer requires this, but it's not actually used in our logic
      originalname: fileName, //Multer requires this, but it's not actually used in our logic
      mimetype: mimeType,
      size: size,
      encoding: 'base64',
      destination: '',
      stream: '' as unknown as Readable,
      filename: fileName,
      path: '',
      buffer: buffer || Buffer.from(''),
    };

    const newFile = await this.fileService.upload({ userId }, file);

    const existingEntity = await this.fileRepository
      .createQueryBuilder('entity')
      .andWhere("entity.properties->>'fileId' = :fileId", { fileId: newFile.id })
      .getOne();

    let entity = !existingEntity
      ? await this.fileRepository.create({
          id: uuidv7(),
          name: fileName,
          entity_type: 'File',
          description: 'File',
          linked_table: 'files',
          linked_id: newFile.id,
          user: {
            id: userId,
          },
        })
      : existingEntity;

    entity = await this.fileRepository.save(entity);

    return { file: newFile, entity };
  }

  @OnEvent(Events.FILE_UPLOAD)
  async handleFileUploaded(payload: EventPayloads[Events.FILE_UPLOAD]) {
    const file = await this.fileService.findOne({ userId: payload.userId }, payload.fileId);

    const existingEntity = await this.fileRepository
      .createQueryBuilder('entity')
      .andWhere("entity.properties->>'fileId' = :fileId", { fileId: file.id })
      .getOne();

    const entity = !existingEntity
      ? await this.fileRepository.create({
          id: uuidv7(),
          name: file.name,
          entity_type: 'File',
          description: 'File',
          linked_table: 'files',
          linked_id: file.id,
          user: {
            id: payload.userId,
          },
        })
      : existingEntity;

    await this.fileRepository.save(entity);
  }

  /**
   * Convert EventEntity to Memory
   */
  private eventToMemory(event: EventEntity): Memory {
    const location: MemoryLocation | undefined = event.location_coordinates
      ? {
          id: event.location_entity_id || event.id,
          name: event.location_name,
          lat: (event.location_coordinates as Point).coordinates[1], // PostGIS format: [lng, lat]
          lng: (event.location_coordinates as Point).coordinates[0],
          address: event.location_name || undefined,
        }
      : undefined;

    return {
      id: event.id,
      type: 'event',
      title: event.title,
      description: event.description,
      timestamp: event.start_time,
      category: event.category || event.event_type || 'Event',
      location,
      tags: event.tags || [],
      userId: event.user?.id || '',
      sourceLink: event.source_id ? `${event.source_system}/${event.source_id}` : undefined,
      metadata: {
        eventId: event.id,
        eventType: event.event_type || undefined,
        eventName: event.title || undefined,
        synthetic: event.is_predicted || event.is_inferred,
        confidenceScore: event.confidence_score,
        isRecurring: event.is_recurring,
        isAllDay: event.is_all_day,
        priority: event.priority,
        status: event.status,
        sourceType: event.source_type,
        sourceSystem: event.source_system,
        sourceId: event.source_id,
        durationMinutes: event.duration_minutes,
        endTime: event.end_time,
        organizerEntityId: event.organizer_entity_id,
        participantEntityIds: event.participant_entity_ids,
        ...event.metadata,
      },
    };
  }

  /**
   * Convert CommunicationEntity to Memory
   */
  private communicationToMemory(comm: CommunicationEntity): Memory {
    try {
      // Create a unique ID from the composite primary key components
      const id = `${comm.user_id}-${comm.time.getTime()}-${comm.communication_type}`;

      return {
        id,
        type: 'communication',
        title: comm.subject || `${comm.communication_type} Communication`,
        description: comm.content,
        timestamp: comm.time,
        category: comm.category || comm.communication_type,
        tags: comm.tags || [],
        userId: comm.user_id,
        metadata: {
          communicationType: comm.communication_type,
          direction: comm.direction,
          threadId: comm.thread_id,
          fromEntityId: comm.from_entity_id,
          toEntityIds: comm.to_entity_ids,
          participantsMetadata: comm.participants_metadata,
          durationSeconds: comm.duration_seconds,
          sentimentScore: comm.sentiment_score,
          importanceScore: comm.importance_score,
          urgencyScore: comm.urgency_score,
          isEncrypted: comm.is_encrypted,
          connectionId: comm.connection_id,
        },
      };
    } catch (error) {
      this.logger.error('Error converting communication to memory', {
        error: error instanceof Error ? error.message : error,
        communication: {
          userId: comm.user_id,
          time: comm.time,
          communicationType: comm.communication_type,
          subject: comm.subject,
        },
      });
      throw error;
    }
  }

  /**
   * Convert ContentEntity to Memory
   */
  private contentToMemory(content: ContentEntity): Memory {
    return {
      id: content.id,
      type: 'content',
      title: content.title || 'Content',
      description: content.text,
      timestamp: content.created_at,
      category: content.type || 'Content',
      tags: [],
      userId: content.user?.id || '',
      sourceLink: content.url || content.source_url || undefined,
      metadata: {
        contentType: content.type,
        mimetype: content.mimetype,
        externalId: content.external_id,
        sourceData: content.source_data,
        eventId: content.event?.id,
      },
    };
  }

  /**
   * Get memories from browser activity table
   */
  private async getBrowserActivityMemories(userId: string, params: MemorySearchParams): Promise<Memory[]> {
    this.logger.debug('getBrowserActivityMemories called', { userId, params });

    let query = this.browserActivityRepository
      .createQueryBuilder('browser_activity')
      .where('browser_activity.user_id = :userId', { userId });

    // Apply search query
    if (params.query) {
      query = query.andWhere(
        '(browser_activity.title ILIKE :query OR browser_activity.url ILIKE :query OR browser_activity.page_summary ILIKE :query)',
        {
          query: `%${params.query}%`,
        },
      );
    }

    // Apply date filters
    if (params.startDate) {
      query = query.andWhere('browser_activity.time >= :startDate', { startDate: params.startDate });
    }

    if (params.endDate) {
      query = query.andWhere('browser_activity.time <= :endDate', { endDate: params.endDate });
    }

    query = query.orderBy('browser_activity.time', 'DESC').limit(100);

    const browserActivities = await query.getMany();
    const memories = browserActivities.map((activity) => this.browserActivityToMemory(activity));

    return memories;
  }

  /**
   * Convert BrowserActivityEntity to Memory
   */
  private browserActivityToMemory(activity: BrowserActivityEntity): Memory {
    // Create a unique ID from the composite primary key components
    const id = `${activity.user_id}-${activity.time.getTime()}-${activity.device_id}`;

    return {
      id,
      type: 'browser',
      title: activity.title || this.extractDomainFromUrl(activity.url),
      description: activity.page_summary || `Visited ${this.extractDomainFromUrl(activity.url)}`,
      timestamp: activity.time,
      category: activity.category || 'Browser Activity',
      tags: this.generateBrowserActivityTags(activity),
      userId: activity.user_id,
      sourceLink: activity.url,
      metadata: {
        entityType: 'BrowserActivity',
        actionType: activity.action_type,
        deviceId: activity.device_id,
        durationSeconds: activity.duration_seconds,
        scrollDepthPercent: activity.scroll_depth_percent,
        productivityScore: activity.productivity_score,
        isIncognito: activity.is_incognito,
        containsSensitive: activity.contains_sensitive,
        properties: activity.properties,
        pageEmbedding: activity.page_embedding,
        url: activity.url,
      },
    };
  }

  private extractDomainFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);

      return urlObj.hostname;
    } catch {
      return url;
    }
  }

  private generateBrowserActivityTags(activity: BrowserActivityEntity): string[] {
    const tags: string[] = [];

    if (activity.action_type) {
      tags.push(activity.action_type);
    }

    if (activity.category) {
      tags.push(activity.category);
    }

    if (activity.productivity_score && activity.productivity_score > 0.7) {
      tags.push('productive');
    }

    if (activity.duration_seconds && activity.duration_seconds > 300) {
      tags.push('long-session');
    }

    if (activity.scroll_depth_percent && activity.scroll_depth_percent > 80) {
      tags.push('thoroughly-read');
    }

    // Add domain-based tags
    const domain = this.extractDomainFromUrl(activity.url);
    if (domain.includes('github.com')) {
      tags.push('development');
    } else if (domain.includes('youtube.com')) {
      tags.push('video');
    } else if (domain.includes('news.') || domain.includes('cnn.com') || domain.includes('bbc.com')) {
      tags.push('news');
    }

    return tags;
  }
}
