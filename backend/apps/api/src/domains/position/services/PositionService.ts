import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, Point, In } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { DeviceService } from '@ci/domains/devices';
import { EventService } from '@ci/domains/events';
import {
  PositionCreatedEvent,
  PositionUpdatedEvent,
  PositionRemovedEvent,
} from '@ci/domains/position/events';

import { PositionEntity, LocationSource } from '../entities/PositionEntity';
import type {
  CreatePositionDto,
  Position,
  Geofence,
  GeofenceRadius,
  GeofencePolygon,
  UpdatePositionDto,
} from '../types';

@Injectable()
export class PositionService {
  constructor(
    @InjectRepository(PositionEntity)
    private readonly positionRepository: Repository<PositionEntity>,
    private readonly deviceService: DeviceService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PositionService.name);
  }

  async create(context: UserServiceContext, data: CreatePositionDto[]): Promise<Position[]> {
    this.logger.log('Creating position records', {
      userId: context.userId,
      count: data.length,
    });

    const uniquePositions = this.deduplicateByTime(data);

    if (uniquePositions.length < data.length) {
      this.logger.log('Deduplicated positions', {
        originalCount: data.length,
        uniqueCount: uniquePositions.length,
        duplicatesRemoved: data.length - uniquePositions.length,
      });
    }

    const times = uniquePositions.map((item) => new Date(item.time));
    const existingPositions = await this.findExistingByTimes(context, times);
    const existingTimesSet = new Set(existingPositions.map((p) => p.time.toISOString()));
    const newPositions: CreatePositionDto[] = [];

    for (const item of uniquePositions) {
      const itemTime = new Date(item.time).toISOString();

      if (!existingTimesSet.has(itemTime)) {
        if (item.device_id) {
          const device = await this.deviceService.findById(context, item.device_id);

          if (!device) {
            this.logger.warn('Device not found for position', {
              deviceId: item.device_id,
              userId: context.userId,
            });
          }
        }

        const normalizedItem = {
          ...item,
          headingDegrees: this.normalizeHeading(item.heading_degrees),
        };

        newPositions.push(normalizedItem);
      }
    }

    const createdEntities: PositionEntity[] = [];

    if (newPositions.length > 0) {
      const entitiesToSave = newPositions.map((item) => this.createPositionEntity(context, item));
      const saved = await this.positionRepository.save(entitiesToSave);
      for (const position of saved) {
        await this.eventService.send(PositionCreatedEvent, {
          positionId: position.id,
        });
      }

      createdEntities.push(...saved);
    }

    const allPositions = [...existingPositions, ...createdEntities]
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .map((entity) => PositionEntity.toEgressType(entity));

    this.logger.log('Successfully processed position records', {
      userId: context.userId,
      totalCount: allPositions.length,
      newCount: createdEntities.length,
      existingCount: existingPositions.length,
    });

    return allPositions;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Position | null)[]> {
    const entities = await this.positionRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    const map = new Map(entities.map((entity) => [entity.id, PositionEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Position | null> {
    const result = await this.positionRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    if (result == null) {
      return null;
    }

    return PositionEntity.toEgressType(result);
  }

  async update(context: ServiceContext, id: string, data: UpdatePositionDto): Promise<Position | null> {
    const updateData: Partial<PositionEntity> = {};

    if (data.time !== undefined) {
      updateData.time = new Date(data.time);
    }

    if (data.location !== undefined) {
      updateData.location = data.location
        ? {
            type: 'Point' as const,
            coordinates: [data.location.x, data.location.y],
          }
        : null;
    }

    if (data.altitude_meters !== undefined) {
      updateData.altitudeMeters = data.altitude_meters;
    }

    if (data.accuracy_meters !== undefined) {
      updateData.accuracyMeters = data.accuracy_meters;
    }

    if (data.hdop !== undefined) {
      updateData.hdop = data.hdop;
    }

    if (data.vdop !== undefined) {
      updateData.vdop = data.vdop;
    }

    if (data.heading_degrees !== undefined) {
      updateData.headingDegrees = data.heading_degrees;
    }

    if (data.speed_meters_per_second !== undefined) {
      updateData.speedMetersPerSecond = data.speed_meters_per_second;
    }

    if (data.address !== undefined) {
      updateData.address = data.address;
    }

    if (data.city !== undefined) {
      updateData.city = data.city;
    }

    if (data.region !== undefined) {
      updateData.region = data.region;
    }

    if (data.country !== undefined) {
      updateData.country = data.country;
    }

    if (data.postal_code !== undefined) {
      updateData.postalCode = data.postal_code;
    }

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.description !== undefined) {
      updateData.description = data.description;
    }

    if (data.provider !== undefined) {
      updateData.provider = data.provider;
    }

    if (data.source !== undefined) {
      updateData.source = data.source;
    }

    if (data.activity_type !== undefined) {
      updateData.activityType = data.activity_type;
    }

    const position = await this.positionRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });

    if (position) {
      Object.assign(position, updateData);
      await this.positionRepository.save(position);
    } else {
      return null;
    }

    await this.eventService.send(PositionUpdatedEvent, {
      positionId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const position = await this.positionRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    if (!position) {
      return false;
    }

    await this.positionRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        user: {
          id: context.userId,
        },
      }),
    });

    await this.eventService.send(PositionRemovedEvent, {
      positionId: id,
    });

    return true;
  }

  async findByDateRange(context: ServiceContext, start: Date, end: Date): Promise<Position[]> {
    this.logger.log('Fetching positions for date range', {
      userId: context.userId,
      start: start.toISOString(),
      end: end.toISOString(),
    });

    const results = await this.positionRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        time: Between(start, end),
      },
      order: { time: 'DESC' },
    });

    return results.map((entity) => PositionEntity.toEgressType(entity));
  }

  async findByGeofence(
    context: ServiceContext,
    geofence: Geofence,
    startDate?: Date,
    endDate?: Date,
  ): Promise<Position[]> {
    this.logger.log('Fetching positions within geofence', {
      userId: context.userId,
      geofenceType: 'radius' in geofence ? 'radius' : 'polygon',
      startDate: startDate?.toISOString(),
      endDate: endDate?.toISOString(),
    });

    let whereClause = 'location IS NOT NULL';
    const params: (string | number)[] = [];
    let paramIndex = 1;

    // Only filter by user_id if not system user
    if (context.userId !== SYSTEM_USER) {
      whereClause += ` AND user_id = $${paramIndex}`;
      params.push(context.userId);
      paramIndex++;
    }

    if ('radius_meters' in geofence) {
      const radiusGeofence = geofence as GeofenceRadius;
      whereClause += ` AND ST_DWithin(
        location::geography,
        ST_SetSRID(ST_MakePoint($${paramIndex}, $${paramIndex + 1}), 4326)::geography,
        $${paramIndex + 2}
      )`;
      params.push(
        radiusGeofence.center.longitude,
        radiusGeofence.center.latitude,
        radiusGeofence.radius_meters,
      );
      paramIndex += 3;
    } else {
      const polygonGeofence = geofence as GeofencePolygon;
      if (polygonGeofence.coordinates.length < 3) {
        this.logger.warn('Polygon geofence must have at least 3 coordinates');

        return [];
      }

      const coordinatesStr = polygonGeofence.coordinates
        .map((coord) => `${coord.longitude} ${coord.latitude}`)
        .join(', ');
      const firstCoord = polygonGeofence.coordinates[0];
      const polygonWKT = `POLYGON((${coordinatesStr}, ${firstCoord.longitude} ${firstCoord.latitude}))`;

      whereClause += ` AND ST_Within(
        location::geography,
        ST_GeogFromText($${paramIndex})::geography
      )`;
      params.push(`SRID=4326;${polygonWKT}`);
      paramIndex += 1;
    }

    if (startDate) {
      whereClause += ` AND time >= $${paramIndex}`;
      params.push(startDate.toISOString());
      paramIndex += 1;
    }

    if (endDate) {
      whereClause += ` AND time <= $${paramIndex}`;
      params.push(endDate.toISOString());
    }

    const rawResults = await this.positionRepository.query(
      `SELECT * FROM ci.position WHERE ${whereClause} ORDER BY time DESC`,
      params,
    );

    return this.mapRawResultsToPositions(rawResults);
  }

  private createPositionEntity(context: UserServiceContext, item: CreatePositionDto): PositionEntity {
    const location = item.location
      ? {
          type: 'Point' as const,
          coordinates: [item.location.x, item.location.y],
        }
      : null;

    return this.positionRepository.create({
      id: uuidv7(),
      time: new Date(item.time),
      userId: context.userId,
      deviceId: item.device_id ?? null,
      location,
      altitudeMeters: item.altitude_meters ?? null,
      accuracyMeters: item.accuracy_meters ?? null,
      hdop: item.hdop ?? null,
      vdop: item.vdop ?? null,
      headingDegrees: item.heading_degrees ?? null,
      speedMetersPerSecond: item.speed_meters_per_second ?? null,
      address: item.address ?? null,
      city: item.city ?? null,
      region: item.region ?? null,
      country: item.country ?? null,
      postalCode: item.postal_code ?? null,
      name: item.name ?? null,
      description: item.description ?? null,
      provider: item.provider ?? null,
      source: item.source,
      activityType: item.activity_type ?? null,
      locationEntityId: item.location_entity_id ?? null,
      referenceEntityId: item.reference_entity_id ?? null,
      relativeCoordinates: item.relative_coordinates ?? {},
      relativeOrientation: item.relative_orientation ?? {},
    });
  }

  private async findExistingByTimes(context: UserServiceContext, times: Date[]): Promise<PositionEntity[]> {
    if (times.length === 0) {
      return [];
    }

    return this.positionRepository.find({
      where: {
        userId: context.userId,
        time: In(times),
      },
    });
  }

  private deduplicateByTime(positions: CreatePositionDto[]): CreatePositionDto[] {
    const seenTimes = new Map<string, CreatePositionDto>();
    for (const position of positions) {
      seenTimes.set(position.time, position);
    }

    return Array.from(seenTimes.values());
  }

  private normalizeHeading(heading?: number): number | undefined {
    if (heading === undefined || heading < 0 || heading > 360) {
      return undefined;
    }

    return heading;
  }

  private mapRawResultsToPositions(rawResults: Array<Record<string, unknown>>): Position[] {
    return rawResults.map((row) => {
      const entity = new PositionEntity();
      entity.time = new Date(row.time as string);
      entity.userId = row.user_id as string;
      entity.deviceId = row.device_id as string | null;
      entity.location = this.parseLocation(row.location);
      entity.altitudeMeters = row.altitude_meters as number | null;
      entity.accuracyMeters = row.accuracy_meters as number | null;
      entity.hdop = row.hdop as number | null;
      entity.vdop = row.vdop as number | null;
      entity.headingDegrees = row.heading_degrees as number | null;
      entity.speedMetersPerSecond = row.speed_meters_per_second as number | null;
      entity.address = row.address as string | null;
      entity.city = row.city as string | null;
      entity.region = row.region as string | null;
      entity.country = row.country as string | null;
      entity.postalCode = row.postal_code as string | null;
      entity.name = row.name as string | null;
      entity.description = row.description as string | null;
      entity.provider = row.provider as string | null;
      entity.source = row.source as LocationSource;
      entity.activityType = row.activity_type as string | null;
      entity.locationEntityId = row.location_entity_id as string | null;
      entity.referenceEntityId = row.reference_entity_id as string | null;
      entity.relativeCoordinates = (row.relative_coordinates as Record<string, unknown>) || {};
      entity.relativeOrientation = (row.relative_orientation as Record<string, unknown>) || {};
      entity.isPrivate = (row.is_private as boolean) ?? false;

      return PositionEntity.toEgressType(entity);
    });
  }

  private parseLocation(location: unknown): Point | null {
    if (!location) {
      return null;
    }

    if (
      typeof location === 'object' &&
      location !== null &&
      'type' in location &&
      'coordinates' in location
    ) {
      return location as Point;
    }

    if (typeof location === 'string' && location.includes('POINT')) {
      const match = location.match(/POINT\(([^)]+)\)/);
      if (match) {
        const [lon, lat] = match[1].split(' ').map(Number);

        return {
          type: 'Point',
          coordinates: [lon, lat],
        };
      }
    }

    return null;
  }
}
