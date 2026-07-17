import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { computeChunkSize } from '@ci/common/persistence';
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

  /**
   * Idempotent find-or-create for reverse-geocoded Places. Used by
   * GeocodeBatchListener after a coordinate→name resolution to ensure each
   * named location resolves to exactly one Place row, so events can be linked
   * via `events.location_entity_id` and "events at <place>" queries work.
   *
   * Uniqueness key: `(owner_user_id, lower(btrim(name)), round(lat, 3),
   * round(lng, 3))`. 3 decimal places ≈ 110 m, which absorbs GPS jitter at the
   * same address without merging geographically distinct places that share a
   * generic name like "Starbucks".
   *
   * Backed by the partial unique index `entities_reverse_geocode_dedup_idx`
   * scoped to `properties.source = 'reverse_geocode'`. The two-step flow —
   * INSERT ... ON CONFLICT DO NOTHING followed by SELECT — is atomic against
   * concurrent callers: at most one INSERT wins per (user, key) tuple, and any
   * loser falls through to SELECT and returns the same id.
   *
   * Emits `PlaceCreatedEvent` only on actual insertion (so search-indexing and
   * graph-sync don't fire for every event in a busy place).
   */
  async findOrCreateForGeocode(
    context: UserServiceContext,
    input: { name: string; lat: number; lng: number },
  ): Promise<{ id: string; created: boolean }> {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error('findOrCreateForGeocode: name must be non-empty');
    }

    // Round to 3dp via Number.toFixed so the value matches the SQL-side
    // round(numeric, 3) used in the partial unique index.
    const latR = Number(input.lat.toFixed(3));
    const lngR = Number(input.lng.toFixed(3));

    const newId = uuidv7();
    const properties = {
      source: 'reverse_geocode',
      type: 'address',
      lat: latR,
      lng: lngR,
    };

    // INSERT ... ON CONFLICT DO NOTHING: races safely with concurrent callers
    // for the same key. Loser sees zero rows affected; both fall through to
    // the SELECT below and return the same id.
    await this.placeRepository.manager.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties)
       VALUES ($1, 'Location', $2, $3, $4::jsonb)
       ON CONFLICT DO NOTHING`,
      [newId, context.userId, trimmedName, JSON.stringify(properties)],
    );

    // Read back the canonical row (whether we inserted or hit a conflict).
    // The predicate matches the partial unique index exactly so the lookup
    // can use it.
    const rows: Array<{ entity_id: string; was_new: boolean }> = await this.placeRepository.manager.query(
      `SELECT entity_id, entity_id = $1 AS was_new
         FROM ci.entities
        WHERE entity_type = 'Location'
          AND owner_user_id = $2
          AND properties->>'source' = 'reverse_geocode'
          AND lower(btrim(name)) = lower(btrim($3))
          AND round((properties->>'lat')::numeric, 3) = $4::numeric
          AND round((properties->>'lng')::numeric, 3) = $5::numeric
        LIMIT 1`,
      [newId, context.userId, trimmedName, latR, lngR],
    );

    if (rows.length === 0) {
      // Unreachable in steady state: either the INSERT succeeded, or a
      // conflicting row already existed and the SELECT finds it. If we hit
      // this, the unique index and SELECT predicate have drifted apart.
      throw new Error(
        `findOrCreateForGeocode: failed to find or create place for "${trimmedName}" at (${latR}, ${lngR})`,
      );
    }

    const { entity_id, was_new } = rows[0];

    if (was_new) {
      await this.eventService.send(PlaceCreatedEvent, { placeId: entity_id });
    }

    return { id: entity_id, created: was_new };
  }

  /**
   * @param options.emitCreated When true (default) a PlaceCreatedEvent is sent per
   *   row so it indexes/enriches live. The bulk path (`createMany`) passes false:
   *   emitting a per-row pgboss event for every ingested row is the dominant cost at
   *   import volume, so bulk-loaded rows are instead swept by the post-load
   *   search-index backfill.
   */
  async create(
    context: UserServiceContext,
    data: CreatePlaceDto | CreatePlaceDto[],
    options: { emitCreated?: boolean } = {},
  ): Promise<Place[]> {
    const { emitCreated = true } = options;
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

        if (emitCreated) {
          await this.eventService.send(PlaceCreatedEvent, {
            placeId: place.id,
          });
        }

        return PlaceEntity.toEgressType(placeResult);
      }),
    );
  }

  /**
   * Batch places ingest for the importer. Replaces the per-row save +
   * PlaceCreatedEvent loop with one set-based INSERT plus one hydration SELECT.
   * createPlace has no dedup key (Places are deduped separately by
   * findOrCreateForGeocode), so this is a plain multi-row INSERT — every input
   * row is inserted, matching create()'s behaviour. Returns the created places in
   * input order.
   *
   * Bulk ingest does NOT emit a per-row PlaceCreatedEvent: the per-row pgboss
   * fan-out was the dominant cost at import volume. Search indexing for
   * bulk-loaded rows is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill). Single-row create() still
   * emits, so interactive creates index live.
   */
  async createMany(context: UserServiceContext, data: CreatePlaceDto[]): Promise<Place[]> {
    if (data.length === 0) {
      return [];
    }

    const entities = data.map((item) =>
      this.placeRepository.create({
        ...item,
        entityType: 'Location',
        id: item.id ?? uuidv7(),
        user: {
          id: context.userId,
        },
      }),
    );

    // Split into param-budget-bounded chunks so a large batch never exceeds
    // Postgres' 65535 bind-param limit (computeChunkSize is the same helper
    // bulkInsertIdempotent uses). Places have no dedup key, so every chunk is a
    // plain multi-row INSERT.
    const chunkSize = computeChunkSize(this.placeRepository.metadata.columns.length);
    for (let offset = 0; offset < entities.length; offset += chunkSize) {
      await this.placeRepository
        .createQueryBuilder()
        .insert()
        // Route through `metadata.target` so TS picks the `ObjectLiteral` overload
        // of `.values()`; passing the entity class narrows to
        // `_QueryDeepPartialEntity`, which rejects the jsonb `properties` column.
        .into(this.placeRepository.metadata.target)
        .values(entities.slice(offset, offset + chunkSize))
        .execute();
    }

    // Hydrate with the user relation so the returned rows match findById/findAll
    // fidelity (toEgressType reads entity.user).
    const ids = entities.map((entity) => entity.id);
    const rows = await this.placeRepository.find({
      where: { id: In(ids) },
      relations: ['user'],
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return entities.map((entity) => PlaceEntity.toEgressType(byId.get(entity.id) ?? entity));
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
