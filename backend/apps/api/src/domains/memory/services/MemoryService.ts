import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/services';
import { RequestContext } from '@ci/common/types';

import { ContentEntity } from '../entities/ContentEntity';
import { EventEntity } from '../entities/EventEntity';
import { LocationEntity } from '../entities/LocationEntity';
import { PersonEntity } from '../entities/PersonEntity';
import { PlaceEntity } from '../entities/PlaceEntity';
import { ThingEntity } from '../entities/ThingEntity';
import { Memory, MemoryLocation, MemoryResponse, MemorySearchParams } from '../types';

@Injectable()
export class MemoryService {
  private logger = new LoggerService(MemoryService.name);

  constructor(
    @InjectRepository(ContentEntity)
    private contentRepo: Repository<ContentEntity>,
    @InjectRepository(EventEntity)
    private eventRepo: Repository<EventEntity>,
    @InjectRepository(LocationEntity)
    private locationRepo: Repository<LocationEntity>,
    @InjectRepository(PersonEntity)
    private personRepo: Repository<PersonEntity>,
    @InjectRepository(PlaceEntity)
    private placeRepo: Repository<PlaceEntity>,
    @InjectRepository(ThingEntity)
    private thingRepo: Repository<ThingEntity>,
  ) {}

  async findAll(context: RequestContext, params: MemorySearchParams): Promise<MemoryResponse> {
    this.logger.debug('Finding memories', { userId: context.userId, params });

    const limit = params.limit || 50;
    const offset = params.offset || 0;

    try {
      // Fetch only events as anchors
      const [events, eventsCount] = await this.findEvents(context, params);

      this.logger.debug('Found events', {
        eventsCount,
        userId: context.userId,
      });

      // Convert events to synthetic Memory objects by hydrating related objects
      const syntheticMemories = await Promise.all(
        events.map((e) => this.createSyntheticMemoriesFromEvent(e)),
      );

      // Flatten the array since each event can produce multiple synthetic memories
      const allMemories = syntheticMemories
        .flat()
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(offset, offset + limit);

      const response = {
        data: allMemories,
        total: eventsCount, // This might need adjustment based on synthetic object count
        limit,
        offset,
      };

      this.logger.debug('Returning memory response', {
        dataLength: response.data.length,
        total: response.total,
        memoriesWithLocation: response.data.filter((m) => m.location).length,
      });

      return response;
    } catch (error) {
      this.logger.error('Error in findAll', { error, userId: context.userId });
      throw error;
    }
  }

  async findOne(context: RequestContext, id: string): Promise<Memory> {
    // Extract the event ID from synthetic memory ID (format: memory-{eventId}-{type}-{index})
    const parts = id.split('-');
    let eventId: string;

    if (parts[0] === 'memory' && parts.length >= 3) {
      eventId = parts[1];
    } else {
      eventId = id; // Fallback to direct ID
    }

    const event = await this.eventRepo.findOne({
      where: { id: eventId },
      relations: ['tags', 'user'],
    });

    if (!event) {
      throw new NotFoundException(`Memory with id ${id} not found`);
    }

    // Create synthetic memories from the event
    const syntheticMemories = await this.createSyntheticMemoriesFromEvent(event);

    // Find the specific synthetic memory by ID
    const memory = syntheticMemories.find((m) => m.id === id);

    if (!memory) {
      throw new NotFoundException(`Memory with id ${id} not found`);
    }

    return memory;
  }

  private async findEvents(
    context: RequestContext,
    params: MemorySearchParams,
  ): Promise<[EventEntity[], number]> {
    const query = this.eventRepo
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.tags', 'tags')
      .leftJoinAndSelect('event.user', 'user');

    if (params.query) {
      query.andWhere(
        '(event.name ILIKE :query OR event.description ILIKE :query OR event.type ILIKE :query)',
        { query: `%${params.query}%` },
      );
    }

    if (params.startDate) {
      query.andWhere(
        '(event.start_time >= :startDate OR (event.start_time IS NULL AND event.created_at >= :startDate))',
        { startDate: params.startDate },
      );
    }

    if (params.endDate) {
      query.andWhere(
        '(event.start_time <= :endDate OR (event.start_time IS NULL AND event.created_at <= :endDate))',
        { endDate: params.endDate },
      );
    }

    const result = await query.getManyAndCount();

    this.logger.debug('Event query result', {
      count: result[1],
      returnedCount: result[0].length,
      userId: context.userId,
    });

    return result;
  }

  private async findContents(
    context: RequestContext,
    params: MemorySearchParams,
  ): Promise<[ContentEntity[], number]> {
    const query = this.contentRepo
      .createQueryBuilder('content')
      .leftJoinAndSelect('content.tags', 'tags')
      .leftJoinAndSelect('content.user', 'user')
      .leftJoinAndSelect('content.event', 'event');
    // TEMPORARILY DISABLED: User filtering
    // .where('content.user_id = :userId', { userId: context.userId });

    if (params.query) {
      query.andWhere('(content.title ILIKE :query OR content.text ILIKE :query)', {
        query: `%${params.query}%`,
      });
    }

    const sql = query.getSql();
    this.logger.debug('Content query SQL', { sql, userId: context.userId });

    const result = await query.getManyAndCount();
    this.logger.debug('Content query result', { count: result[1], userId: context.userId });

    return result;
  }

  private async findPeople(
    context: RequestContext,
    params: MemorySearchParams,
  ): Promise<[PersonEntity[], number]> {
    const query = this.personRepo
      .createQueryBuilder('person')
      .leftJoinAndSelect('person.tags', 'tags')
      .leftJoinAndSelect('person.user', 'user');
    // TEMPORARILY DISABLED: User filtering
    // .where('person.user_id = :userId', { userId: context.userId });

    if (params.query) {
      query.andWhere('(person.first_name ILIKE :query OR person.last_name ILIKE :query)', {
        query: `%${params.query}%`,
      });
    }

    return query.getManyAndCount();
  }

  private async findThings(
    context: RequestContext,
    params: MemorySearchParams,
  ): Promise<[ThingEntity[], number]> {
    const query = this.thingRepo
      .createQueryBuilder('thing')
      .leftJoinAndSelect('thing.tags', 'tags')
      .leftJoinAndSelect('thing.user', 'user')
      .leftJoinAndSelect('thing.event', 'event');
    // TEMPORARILY DISABLED: User filtering
    // .where('thing.user_id = :userId', { userId: context.userId });

    if (params.query) {
      query.andWhere('(thing.name ILIKE :query OR thing.description ILIKE :query)', {
        query: `%${params.query}%`,
      });
    }

    return query.getManyAndCount();
  }

  private async eventToMemory(event: EventEntity): Promise<Memory> {
    let location: MemoryLocation | undefined;

    // Log the event we're converting
    this.logger.debug('Converting event to memory', {
      eventId: event.id,
      eventType: event.type,
      hasStartTime: !!event.start_time,
      hasSourceData: !!event.source_data,
      relatedObjects:
        event.source_data && typeof event.source_data === 'object'
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (event.source_data as any).related_objects
          : undefined,
    });

    // First, try to find associated locations through the locations table
    if (event.user?.id && event.start_time) {
      const eventLocations = await this.locationRepo.find({
        where: {
          user: { id: event.user.id },
          datetime: event.start_time,
        },
        relations: ['place'],
        take: 1,
      });

      if (eventLocations.length > 0) {
        const loc = eventLocations[0];
        if (loc.geolocation && typeof loc.geolocation === 'object') {
          const geo = loc.geolocation as Record<string, unknown>;
          if (geo.lat && geo.lng) {
            location = {
              id: loc.id,
              name: loc.place?.name || null,
              lat: parseFloat(String(geo.lat)),
              lng: parseFloat(String(geo.lng)),
              address: loc.place?.name || undefined,
            };
          } else if (geo.latitude && geo.longitude) {
            location = {
              id: loc.id,
              name: loc.place?.name || null,
              lat: parseFloat(String(geo.latitude)),
              lng: parseFloat(String(geo.longitude)),
              address: loc.place?.name || undefined,
            };
          }
        }
      }
    }

    // If no location found, check source_data for related_objects
    if (!location && event.source_data && typeof event.source_data === 'object') {
      const sourceData = event.source_data as Record<string, unknown>;

      // First check for direct location/place data
      if (sourceData.location || sourceData.place) {
        const locData = (sourceData.location || sourceData.place) as Record<string, unknown>;
        if (locData.lat && locData.lng) {
          location = {
            id: `loc-${event.id}`,
            name: (locData.name as string) || event.name,
            lat: parseFloat(String(locData.lat)),
            lng: parseFloat(String(locData.lng)),
            address: locData.address as string | undefined,
          };
        }
      }

      // Check for location references in related_objects
      if (!location && sourceData.related_objects) {
        const relatedObjects = Array.isArray(sourceData.related_objects)
          ? sourceData.related_objects
          : [sourceData.related_objects];

        // Look for location references - all locations now start with loc_
        for (const obj of relatedObjects) {
          if (typeof obj === 'string' && obj.startsWith('loc_')) {
            // Try to find a location with this identifier
            location = await this.findLocationByIdentifier(obj, event);
            if (location) {
              break;
            }
          }
        }
      }
    }

    this.logger.debug('Event location data', {
      eventId: event.id,
      hasLocation: !!location,
      locationData: location,
    });

    // Generate a meaningful title from available data
    let title = event.name;
    if (!title && event.type) {
      // Generate title based on type and location
      if (location) {
        title = `${event.type} at ${location.name}`;
      } else {
        title = event.type;
      }

      // Add activity details from related_objects
      if (event.source_data && typeof event.source_data === 'object') {
        const sourceData = event.source_data as Record<string, unknown>;
        if (sourceData.related_objects && Array.isArray(sourceData.related_objects)) {
          // Extract meaningful details from related objects
          const activities = sourceData.related_objects
            .filter(
              (obj: string) =>
                typeof obj === 'string' &&
                !obj.startsWith('loc_') && // Exclude location references
                !obj.startsWith('place_') && // Exclude place references
                (obj.includes('activity_') || obj.includes('duration_') || obj.includes('dist_')),
            )
            .map((obj: string) => obj.replace(/_/g, ' ').replace('-', ' '));

          if (activities.length > 0) {
            title += ` (${activities.join(', ')})`;
          }
        }
      }
    }

    if (!title) {
      title = 'Untitled Event';
    }

    // Use created_at as timestamp since start_time is null in your data
    const timestamp = event.start_time || event.created_at;

    // Generate description with more context
    let description = event.description;
    if (!description) {
      const parts = [];

      // Add type and date
      parts.push(`${event.type || 'Event'} on ${new Date(timestamp).toLocaleDateString()}`);

      // Add time if available
      if (event.start_time) {
        parts.push(`at ${new Date(event.start_time).toLocaleTimeString()}`);
      }

      // Add location if available
      if (location) {
        parts.push(`at ${location.name}`);
      }

      // Add source info
      if (event.source_url) {
        parts.push(`(via ${event.source_url})`);
      }

      description = parts.join(' ');
    }

    const memory: Memory = {
      id: `memory-${event.id}`,
      type: 'event',
      title: title,
      description: description,
      timestamp: timestamp,
      category: event.type || 'Event',
      location,
      tags: (event.tags?.map((t) => t.label).filter(Boolean) as string[]) || [],
      userId: event.user?.id || '',
      metadata: {
        endTime: event.end_time,
        externalId: event.external_id,
        sourceUrl: event.source_url,
        hasStartTime: !!event.start_time,
        originalType: event.type,
        relatedObjects:
          event.source_data && typeof event.source_data === 'object'
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (event.source_data as any).related_objects
            : undefined,
      },
    };

    this.logger.debug('Created memory from event', {
      memoryId: memory.id,
      memoryTitle: memory.title,
      hasLocation: !!memory.location,
      locationName: memory.location?.name,
    });

    return memory;
  }

  private async contentToMemory(content: ContentEntity, event: EventEntity): Promise<Memory> {
    // Content might be associated with an event that has location
    let location: MemoryLocation | undefined;

    if (content.event) {
      const event = await this.eventRepo.findOne({
        where: { id: content.event.id },
      });

      if (event?.source_data && typeof event.source_data === 'object') {
        const sourceData = event.source_data as Record<string, unknown>;
        if (sourceData.location || sourceData.place) {
          const locData = (sourceData.location || sourceData.place) as Record<string, unknown>;
          if (locData.lat && locData.lng) {
            location = {
              id: `loc-${content.id}`,
              name: (locData.name as string) || content.title,
              lat: parseFloat(String(locData.lat)),
              lng: parseFloat(String(locData.lng)),
              address: locData.address as string | undefined,
            };
          }
        }
      }
    }

    return {
      id: `memory-${content.id}`,
      type: 'content',
      title: content.title || 'Untitled Content',
      description: content.text,
      timestamp: event.start_time || event.created_at || content.created_at,
      category: content.type || 'Content',
      location,
      tags: (content.tags?.map((t) => t.label).filter(Boolean) as string[]) || [],
      userId: content.user?.id || '',
      metadata: {
        url: content.url,
        mimetype: content.mimetype,
        externalId: content.external_id,
        sourceUrl: content.source_url,
      },
    };
  }

  private async personToMemory(person: PersonEntity): Promise<Memory> {
    let location: MemoryLocation | undefined;

    // Check if person has address data that can be geocoded
    if (person.city && person.country) {
      // For now, we'll just note that the person has location data
      // In a real implementation, you might geocode the address
      this.logger.debug('Person has address', {
        personId: person.id,
        city: person.city,
        country: person.country,
      });
    }

    const fullName = [person.first_name, person.last_name].filter(Boolean).join(' ') || 'Unknown Person';

    return {
      id: `memory-${person.id}`,
      type: 'person',
      title: fullName,
      description:
        person.address || [person.city, person.region, person.country].filter(Boolean).join(', ') || null,
      timestamp: person.created_at,
      category: person.type || 'Person',
      location,
      tags: (person.tags?.map((t) => t.label).filter(Boolean) as string[]) || [],
      userId: person.user?.id || '',
      metadata: {
        gender: person.gender,
        avatarUrl: person.avatar_url,
        externalId: person.external_id,
        sourceUrl: person.source_url,
      },
    };
  }

  private async thingToMemory(thing: ThingEntity): Promise<Memory> {
    let location: MemoryLocation | undefined;

    // Things might have location through their associated event
    if (thing.event) {
      const eventMemory = await this.eventToMemory(thing.event);
      location = eventMemory.location;
    }

    return {
      id: `memory-${thing.id}`,
      type: 'thing',
      title: thing.name || 'Untitled Thing',
      description: thing.description,
      timestamp: thing.created_at,
      category: thing.type || 'Thing',
      location,
      tags: (thing.tags?.map((t) => t.label).filter(Boolean) as string[]) || [],
      userId: thing.user?.id || '',
      metadata: {
        externalId: thing.external_id,
        sourceUrl: thing.source_url,
        eventId: thing.event?.id,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getDebugInfo(context: RequestContext) {
    // TEMPORARILY DISABLED: User filtering
    const [locations, locCount] = await this.locationRepo.findAndCount({
      take: 5,
    });

    const [places, placeCount] = await this.placeRepo.findAndCount({
      take: 5,
    });

    // Also get event count
    const eventCount = await this.eventRepo.count();

    const contentCount = await this.contentRepo.count();

    const personCount = await this.personRepo.count();

    const thingCount = await this.thingRepo.count();

    return {
      counts: {
        events: eventCount,
        contents: contentCount,
        people: personCount,
        things: thingCount,
        locations: locCount,
        places: placeCount,
      },
      sampleLocations: locations.map((l) => ({
        id: l.id,
        datetime: l.datetime,
        geolocation: l.geolocation,
        placeId: l.place?.id,
      })),
      samplePlaces: places.map((p) => ({
        id: p.id,
        name: p.name,
        geolocation: p.geolocation,
      })),
    };
  }

  async getRawEvents() {
    // Get all events without any filtering to see what's in the database
    const events = await this.eventRepo
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.user', 'user')
      .leftJoinAndSelect('event.tags', 'tags')
      .limit(10)
      .getMany();

    this.logger.debug('Raw events query result', {
      count: events.length,
      firstEvent: events[0] || null,
    });

    // Also check if there are any events without users
    const eventsWithoutUser = await this.eventRepo
      .createQueryBuilder('event')
      .where('event.user_id IS NULL')
      .limit(5)
      .getMany();

    this.logger.debug('Events without user', {
      count: eventsWithoutUser.length,
    });

    // Get distinct user IDs from events
    const userIds = await this.eventRepo
      .createQueryBuilder('event')
      .select('DISTINCT event.user_id', 'userId')
      .where('event.user_id IS NOT NULL')
      .getRawMany();

    this.logger.debug('Distinct user IDs in events', {
      userIds: userIds.map((u) => u.userId),
    });

    return events.map((event) => ({
      id: event.id,
      name: event.name,
      type: event.type,
      userId: event.user?.id,
      userIdDirect: (event as unknown as Record<string, unknown>).user_id, // Check if user_id is set directly
      startTime: event.start_time,
      endTime: event.end_time,
      hasUser: !!event.user,
      tagCount: event.tags?.length || 0,
      createdAt: event.created_at,
    }));
  }

  async findAllDebug(): Promise<MemoryResponse> {
    this.logger.debug('Finding all memories without user filter');

    const limit = 50;
    const offset = 0;

    try {
      // Get events without user filter
      const events = await this.eventRepo.find({
        relations: ['user', 'tags'],
        take: 10,
      });

      this.logger.debug('Found events without filter', {
        eventsCount: events.length,
      });

      // Convert events to synthetic memories
      const syntheticMemories = await Promise.all(
        events.map((e) => this.createSyntheticMemoriesFromEvent(e)),
      );

      // Flatten and sort
      const allMemories = syntheticMemories
        .flat()
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      const response = {
        data: allMemories,
        total: allMemories.length,
        limit,
        offset,
      };

      this.logger.debug('Returning debug memory response', {
        dataLength: response.data.length,
        memoriesWithLocation: response.data.filter((m) => m.location).length,
      });

      return response;
    } catch (error) {
      this.logger.error('Error in findAllDebug', { error });
      throw error;
    }
  }

  async directDatabaseTest() {
    this.logger.warn('DEBUGGING: Direct database test');

    const results: Record<string, unknown> = {};

    try {
      // Test raw SQL queries
      const eventCount = await this.eventRepo.query('SELECT COUNT(*) FROM events');
      results.eventCountRaw = eventCount;

      const eventSample = await this.eventRepo.query('SELECT * FROM events LIMIT 5');
      results.eventSampleRaw = eventSample;

      // Test TypeORM count
      const eventCountTypeorm = await this.eventRepo.count();
      results.eventCountTypeorm = eventCountTypeorm;

      // Test simple find
      const eventFindSimple = await this.eventRepo.find({ take: 5 });
      results.eventFindSimple = eventFindSimple;

      // Check table existence
      const tables = await this.eventRepo.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name IN ('events', 'content', 'people', 'things', 'places', 'locations')
      `);
      results.existingTables = tables;

      // Check event table structure
      const eventColumns = await this.eventRepo.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'events'
      `);
      results.eventColumns = eventColumns;

      // Check events with actual data
      const eventsWithData = await this.eventRepo.query(`
        SELECT * FROM events
        WHERE name IS NOT NULL
        OR description IS NOT NULL
        OR start_time IS NOT NULL
        LIMIT 10
      `);
      results.eventsWithData = eventsWithData;

      // Count events by type
      const eventsByType = await this.eventRepo.query(`
        SELECT type, COUNT(*) as count
        FROM events
        GROUP BY type
        ORDER BY count DESC
      `);
      results.eventsByType = eventsByType;
    } catch (error) {
      results.error = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('DEBUGGING: Direct database test error', { error });
    }

    return results;
  }

  async testEventConversion() {
    this.logger.warn('Testing event conversion');

    try {
      // Get a few raw events
      const events = await this.eventRepo.find({
        relations: ['user', 'tags'],
        take: 5,
      });

      this.logger.warn('Raw events from DB', {
        count: events.length,
        events: events,
      });

      // Convert them to memories
      const memories = await Promise.all(events.map((e) => this.eventToMemory(e)));

      return {
        rawEvents: events,
        convertedMemories: memories,
        conversionCount: memories.length,
      };
    } catch (error) {
      this.logger.error('Error in testEventConversion', { error });
      throw error;
    }
  }

  async testLocationLookup() {
    this.logger.warn('Testing location lookup');

    try {
      // Get some locations
      const locations = await this.locationRepo.find({ take: 5 });

      // Get events with location references
      const eventsWithLocations = await this.eventRepo
        .createQueryBuilder('event')
        .where("event.source_data::text LIKE '%loc_%'")
        .limit(5)
        .getMany();

      const results = {
        locationsInDb: locations.map((l) => ({
          id: l.id,
          identifier: l.identifier,
          geolocation: l.geolocation,
        })),
        eventsWithLocationRefs: eventsWithLocations.map((e) => ({
          id: e.id,
          name: e.name,
          sourceData: e.source_data,
        })),
      };

      // Test conversion of events with locations
      const memoriesWithLocations = await Promise.all(eventsWithLocations.map((e) => this.eventToMemory(e)));

      return {
        ...results,
        memoriesWithLocations: memoriesWithLocations.map((m) => ({
          id: m.id,
          title: m.title,
          hasLocation: !!m.location,
          location: m.location,
        })),
      };
    } catch (error) {
      this.logger.error('Error in testLocationLookup', { error });
      throw error;
    }
  }

  private async findLocationByIdentifier(
    identifier: string,
    event: EventEntity,
  ): Promise<MemoryLocation | undefined> {
    this.logger.debug('Looking for location by identifier', { identifier, eventId: event.id });

    try {
      // Try to find in locations table by identifier
      const location = await this.locationRepo.findOne({
        where: { identifier: identifier },
        relations: ['place'],
      });

      if (location && location.geolocation) {
        const geo = location.geolocation as Record<string, unknown>;
        // Handle both lng and lon field names
        if (geo.lat && (geo.lng || geo.lon)) {
          return {
            id: location.id,
            name: location.place?.name || `Location ${identifier}`,
            lat: parseFloat(String(geo.lat)),
            lng: parseFloat(String(geo.lng || geo.lon)),
            address: location.place?.name || undefined,
          };
        }
      }

      // If not found by identifier, log it for debugging
      this.logger.debug('Location not found by identifier', {
        identifier,
        eventId: event.id,
      });

      // Since all locations should now be in the database with loc_ prefix,
      // we shouldn't need synthetic locations anymore
      this.logger.warn('Location identifier not found in database', {
        identifier,
        eventId: event.id,
      });
    } catch (error) {
      this.logger.error('Error finding location by identifier', { error, identifier });
    }

    return undefined;
  }

  private async createSyntheticMemoriesFromEvent(event: EventEntity): Promise<Memory[]> {
    const memories: Memory[] = [];

    // Always create the base event memory
    const baseMemory = await this.eventToMemory(event);
    memories.push(baseMemory);

    // Extract related objects from source_data
    if (event.source_data && typeof event.source_data === 'object') {
      const sourceData = event.source_data as Record<string, unknown>;
      const relatedObjects = sourceData.related_objects;

      if (relatedObjects && Array.isArray(relatedObjects)) {
        for (let i = 0; i < relatedObjects.length; i++) {
          const objRef = relatedObjects[i];

          if (typeof objRef === 'string') {
            // Create synthetic memories based on object type
            if (objRef.startsWith('person_')) {
              const personMemory = await this.createSyntheticPersonMemory(objRef, event, i);
              if (personMemory) {
                memories.push(personMemory);
              }
            } else if (objRef.startsWith('content_')) {
              const contentMemory = await this.createSyntheticContentMemory(objRef, event, i);
              if (contentMemory) {
                memories.push(contentMemory);
              }
            } else if (objRef.startsWith('thing_')) {
              const thingMemory = await this.createSyntheticThingMemory(objRef, event, i);
              if (thingMemory) {
                memories.push(thingMemory);
              }
            }
            // Skip location references as they're used for the event's location
          }
        }
      }
    }

    return memories;
  }

  private async createSyntheticPersonMemory(
    personRef: string,
    event: EventEntity,
    index: number,
  ): Promise<Memory | null> {
    try {
      // Try to find the actual person entity
      const person = await this.personRepo.findOne({
        where: { external_id: personRef },
        relations: ['tags', 'user'],
      });

      if (person) {
        // Use actual person data
        const memory = await this.personToMemory(person);
        // Override ID to maintain relationship with event
        memory.id = `memory-${event.id}-person-${index}`;
        memory.metadata = {
          ...memory.metadata,
          eventId: event.id,
          eventType: event.type || undefined,
          eventName: event.name || undefined,
        };

        return memory;
      }

      // Create synthetic person if not found
      return {
        id: `memory-${event.id}-person-${index}`,
        type: 'person',
        title: `Person from ${event.name || event.type || 'Event'}`,
        description: `Person referenced in ${event.type || 'event'}`,
        timestamp: event.start_time || event.created_at,
        category: 'Person',
        location: await this.getEventLocation(event),
        tags: (event.tags?.map((t) => t.label).filter(Boolean) as string[]) || [],
        userId: event.user?.id || '',
        metadata: {
          eventId: event.id,
          eventType: event.type || undefined,
          eventName: event.name || undefined,
          personRef: personRef,
          synthetic: true,
        },
      };
    } catch (error) {
      this.logger.error('Error creating synthetic person memory', { error, personRef });

      return null;
    }
  }

  private async createSyntheticContentMemory(
    contentRef: string,
    event: EventEntity,
    index: number,
  ): Promise<Memory | null> {
    try {
      // Try to find the actual content entity
      const content = await this.contentRepo.findOne({
        where: { id: contentRef.replace('content_', '') },
        relations: ['tags', 'user', 'event'],
      });

      if (content) {
        // Use actual content data
        const memory = await this.contentToMemory(content, event);
        // Override ID to maintain relationship with event
        memory.id = `memory-${event.id}-content-${index}`;
        memory.metadata = {
          ...memory.metadata,
          eventId: event.id,
          eventType: event.type || undefined,
          eventName: event.name || undefined,
        };

        return memory;
      }

      // Create synthetic content if not found
      return {
        id: `memory-${event.id}-content-${index}`,
        type: 'content',
        title: `Content from ${event.name || event.type || 'Event'}`,
        description: `Content created during ${event.type || 'event'}`,
        timestamp: event.start_time || event.created_at,
        category: 'Content',
        location: await this.getEventLocation(event),
        tags: (event.tags?.map((t) => t.label).filter(Boolean) as string[]) || [],
        userId: event.user?.id || '',
        metadata: {
          eventId: event.id,
          eventType: event.type || undefined,
          eventName: event.name || undefined,
          contentRef: contentRef,
          synthetic: true,
        },
      };
    } catch (error) {
      this.logger.error('Error creating synthetic content memory', { error, contentRef });

      return null;
    }
  }

  private async createSyntheticThingMemory(
    thingRef: string,
    event: EventEntity,
    index: number,
  ): Promise<Memory | null> {
    try {
      // Try to find the actual thing entity
      const thing = await this.thingRepo.findOne({
        where: { external_id: thingRef },
        relations: ['tags', 'user', 'event'],
      });

      if (thing) {
        // Use actual thing data
        const memory = await this.thingToMemory(thing);
        // Override ID to maintain relationship with event
        memory.id = `memory-${event.id}-thing-${index}`;
        memory.metadata = {
          ...memory.metadata,
          eventId: event.id,
          eventType: event.type || undefined,
          eventName: event.name || undefined,
        };

        return memory;
      }

      // Create synthetic thing if not found
      return {
        id: `memory-${event.id}-thing-${index}`,
        type: 'thing',
        title: `Item from ${event.name || event.type || 'Event'}`,
        description: `Item associated with ${event.type || 'event'}`,
        timestamp: event.start_time || event.created_at,
        category: 'Thing',
        location: await this.getEventLocation(event),
        tags: (event.tags?.map((t) => t.label).filter(Boolean) as string[]) || [],
        userId: event.user?.id || '',
        metadata: {
          eventId: event.id,
          eventType: event.type || undefined,
          eventName: event.name || undefined,
          thingRef: thingRef,
          synthetic: true,
        },
      };
    } catch (error) {
      this.logger.error('Error creating synthetic thing memory', { error, thingRef });

      return null;
    }
  }

  private async getEventLocation(event: EventEntity): Promise<MemoryLocation | undefined> {
    // Extract location from event using existing logic
    let location: MemoryLocation | undefined;

    if (event.user?.id && event.start_time) {
      const eventLocations = await this.locationRepo.find({
        where: {
          user: { id: event.user.id },
          datetime: event.start_time,
        },
        relations: ['place'],
        take: 1,
      });

      if (eventLocations.length > 0) {
        const loc = eventLocations[0];
        if (loc.geolocation && typeof loc.geolocation === 'object') {
          const geo = loc.geolocation as Record<string, unknown>;
          if (geo.lat && geo.lng) {
            location = {
              id: loc.id,
              name: loc.place?.name || null,
              lat: parseFloat(String(geo.lat)),
              lng: parseFloat(String(geo.lng)),
              address: loc.place?.name || undefined,
            };
          } else if (geo.latitude && geo.longitude) {
            location = {
              id: loc.id,
              name: loc.place?.name || null,
              lat: parseFloat(String(geo.latitude)),
              lng: parseFloat(String(geo.longitude)),
              address: loc.place?.name || undefined,
            };
          }
        }
      }
    }

    // Check source_data for location references
    if (!location && event.source_data && typeof event.source_data === 'object') {
      const sourceData = event.source_data as Record<string, unknown>;

      if (sourceData.related_objects && Array.isArray(sourceData.related_objects)) {
        for (const obj of sourceData.related_objects) {
          if (typeof obj === 'string' && obj.startsWith('loc_')) {
            location = await this.findLocationByIdentifier(obj, event);
            if (location) {
              break;
            }
          }
        }
      }
    }

    return location;
  }
}
