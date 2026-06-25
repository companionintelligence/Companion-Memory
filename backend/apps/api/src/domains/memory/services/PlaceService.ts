import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { PlaceEntity, type Place } from '../entities/PlaceEntity';
import { PlaceCreatedEvent, PlaceUpdatedEvent, PlaceRemovedEvent } from '../events';
import type { CreatePlaceDto, UpdatePlaceDto } from '../types';

@Injectable()
export class PlaceService {
  constructor(
    @InjectRepository(PlaceEntity)
    private readonly placeRepository: Repository<PlaceEntity>,
    private readonly eventService: EventService,
  ) {}

  async create(context: UserServiceContext, data: CreatePlaceDto | CreatePlaceDto[]): Promise<Place[]> {
    const isSingle = !Array.isArray(data);
    const dataArray: CreatePlaceDto[] = isSingle ? [data] : data;

    return Promise.all(
      dataArray.map(async (item) => {
        const id = item.id ?? uuidv7();

        const place = await this.placeRepository.create({
          ...item,
          entityType: 'Location',
          id,
          user: {
            id: context.userId,
          },
        });

        const placeResult = await this.placeRepository.save(place);

        await this.eventService.send(PlaceCreatedEvent, {
          placeId: place.id,
        });

        return PlaceEntity.toEgressType(placeResult);
      }),
    );
  }

  /**
   * Batch equivalent of N `createPlace` calls in a single client round-trip.
   * Delegates to `create`, whose array branch already maps over the input
   * with `Promise.all`, preserving input order and emitting one
   * `PlaceCreatedEvent` per row.
   */
  async createMany(context: UserServiceContext, data: CreatePlaceDto[]): Promise<Place[]> {
    return this.create(context, data);
  }

  async findAll(context: UserServiceContext): Promise<Place[]> {
    return this.placeRepository.find({
      where: {
        entityType: 'Location',
        user: {
          id: context.userId,
        },
      },
      relations: ['user'],
    });
  }

  async findById(context: ServiceContext, id: string): Promise<Place | null> {
    const result = await this.placeRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      relations: ['user'],
    });

    return result ? PlaceEntity.toEgressType(result) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Place | null)[]> {
    const result = await this.placeRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      relations: ['user'],
    });

    const map = new Map(result.map((entity) => [entity.id, PlaceEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Lightweight identifiers for the most-recent places, for the unified
   * search/explorer feed. Returns only `{ id, type }`; full entities are
   * batch-resolved downstream by EntityResolutionService.
   */
  async getEntitiesForPlaces(
    context: ServiceContext,
    options: { limit?: number; startTime?: Date; endTime?: Date; order?: 'ASC' | 'DESC' } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.placeRepository
      .createQueryBuilder('place')
      .select('place.id', 'id')
      .where('place.entity_type = :entityType', { entityType: 'Location' })
      .andWhere('place.owner_user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('place.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('place.created_at <= :endTime', { endTime: options.endTime });
    }

    query = query.orderBy('place.created_at', options.order ?? 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'place' as IndexableEntity }));
  }

  async update(context: ServiceContext, id: string, data: UpdatePlaceDto): Promise<Place | null> {
    const { properties, ...rest } = data;

    const place = await this.placeRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    if (place) {
      const props = Object.assign({}, place.properties, { ...properties });

      const result = await this.placeRepository.update(
        {
          id,
          ...(context.userId !== SYSTEM_USER && {
            user: {
              id: context.userId,
            },
          }),
        },
        {
          ...rest,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          properties: props as any, // TypeORM will handle JSON serialization
        },
      );

      if (result.affected === 0) {
        return null;
      }

      await this.eventService.send(PlaceUpdatedEvent, {
        placeId: id,
      });

      return this.findById(context, id);
    } else {
      return null;
    }
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const place = await this.placeRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    if (!place) {
      return false;
    }

    await this.placeRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        user: {
          id: context.userId,
        },
      }),
    });

    await this.eventService.send(PlaceRemovedEvent, {
      placeId: id,
    });

    return true;
  }
}
