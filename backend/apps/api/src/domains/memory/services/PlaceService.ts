import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { isUniqueViolation } from '@ci/common/constants';
import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { computeChunkSize } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { PlaceEntity, type Place, type PlaceKind } from '../entities/PlaceEntity';
import { PlaceCreatedEvent, PlaceUpdatedEvent, PlaceRemovedEvent } from '../events';
import type { CreatePlaceDto, UpdatePlaceDto } from '../types';

import { GraphDeltaWriter } from './GraphDeltaWriter';

/** One Google-style address component ({long_name, short_name, types[]}). */
interface AddressComponent {
  long_name?: string;
  short_name?: string;
  types?: string[];
}

/** Aggregated event stats for a place (PlaceType.visitStats). */
export interface PlaceVisitStats {
  visitCount: number;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
}

/**
 * Geocode address components -> hierarchy levels, most-specific first. Only
 * admin levels city and above become shared hierarchy nodes; street-level
 * detail stays on the place itself.
 */
const COMPONENT_HIERARCHY: Array<{ componentType: string; kind: PlaceKind }> = [
  { componentType: 'locality', kind: 'city' },
  { componentType: 'administrative_area_level_1', kind: 'region' },
  { componentType: 'country', kind: 'country' },
];

@Injectable()
export class PlaceService {
  constructor(
    @InjectRepository(PlaceEntity)
    private readonly placeRepository: Repository<PlaceEntity>,
    private readonly eventService: EventService,
    private readonly graphDeltaWriter: GraphDeltaWriter,
  ) {}

  /**
   * Idempotent find-or-create for reverse-geocoded Places. Used by
   * GeocodeBatchListener after a coordinate→name resolution to ensure each
   * named location resolves to exactly one Place row, so events can be linked
   * via `events.location_entity_id` and "events at <place>" queries work.
   *
   * Uniqueness key: `(owner_user_id, ST_SnapToGrid(location_point, 0.001))`.
   * 0.001° ≈ 110 m, which absorbs GPS jitter at the same address. Backed by
   * `entities_location_snap_dedup_uniq` (Wave C). The two-step flow —
   * INSERT ... ON CONFLICT DO NOTHING followed by SELECT — is atomic against
   * concurrent callers: at most one INSERT wins per (user, cell) tuple, and any
   * loser falls through to SELECT and returns the same id.
   *
   * Emits `PlaceCreatedEvent` only on actual insertion (so search-indexing and
   * graph-sync don't fire for every event in a busy place).
   */
  async findOrCreateForGeocode(
    context: UserServiceContext,
    input: {
      name: string;
      lat: number;
      lng: number;
      /** Geocode provider's stable place id — the strongest dedupe key. */
      placeId?: string | null;
      /** Provider address components ({address_components: [...]}) for hierarchy. */
      components?: Record<string, unknown> | null;
    },
  ): Promise<{ id: string; created: boolean }> {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error('findOrCreateForGeocode: name must be non-empty');
    }

    // Round to 3dp via Number.toFixed so the value matches the SQL-side
    // round(numeric, 3) used in the partial unique index.
    const latR = Number(input.lat.toFixed(3));
    const lngR = Number(input.lng.toFixed(3));
    const placeId = input.placeId?.trim() || null;

    // 1. Provider place_id is the primary identity when available: venue
    // renames and name variants converge on the same row.
    if (placeId) {
      const byPlaceId: Array<{ entity_id: string }> = await this.placeRepository.manager.query(
        `SELECT entity_id
           FROM ci.entities
          WHERE entity_type = 'Location'
            AND owner_user_id = $1
            AND properties->>'place_id' = $2
          LIMIT 1`,
        [context.userId, placeId],
      );

      if (byPlaceId.length > 0) {
        const id = byPlaceId[0].entity_id;
        await this.enrichResolvedPlace(context, id, input.lat, input.lng, placeId);
        await this.ensureHierarchy(context, id, input.components ?? null);

        return { id, created: false };
      }
    }

    const newId = uuidv7();
    const properties: Record<string, unknown> = {
      source: 'reverse_geocode',
      type: 'address',
      lat: latR,
      lng: lngR,
      ...(placeId ? { place_id: placeId } : {}),
    };

    // 2. INSERT ... ON CONFLICT DO NOTHING keyed on the snap-cell unique index:
    // races safely with concurrent callers for the same cell. Loser sees zero
    // rows affected; both fall through to the SELECT below and return the same
    // id. location_point carries FULL precision (snap lives only in the index).
    await this.placeRepository.manager.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, location_point, place_kind)
       VALUES ($1, 'Location', $2, $3, $4::jsonb,
               ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, 'address')
       ON CONFLICT DO NOTHING`,
      [newId, context.userId, trimmedName, JSON.stringify(properties), input.lng, input.lat],
    );

    // Read back the canonical row (whether we inserted or hit a conflict).
    // Predicate matches entities_location_snap_dedup_uniq.
    const rows: Array<{ entity_id: string; was_new: boolean }> = await this.placeRepository.manager.query(
      `SELECT entity_id, entity_id = $1 AS was_new
         FROM ci.entities
        WHERE entity_type = 'Location'
          AND owner_user_id = $2
          AND location_point IS NOT NULL
          AND ST_SnapToGrid(location_point::geometry, 0.001) =
              ST_SnapToGrid(ST_SetSRID(ST_MakePoint($3, $4), 4326), 0.001)
        LIMIT 1`,
      [newId, context.userId, input.lng, input.lat],
    );

    if (rows.length === 0) {
      // The INSERT was swallowed by a conflict on a DIFFERENT unique index than
      // the name+cell one this SELECT is keyed on — in practice
      // entities_place_provider_id_uniq: a concurrent caller committed the same
      // NEW place_id under a different name or coordinate cell between our
      // step-1 lookup and this INSERT. The winner's row is the canonical place,
      // so resolve it by place_id rather than failing the whole resolution.
      if (placeId) {
        const winner: Array<{ entity_id: string }> = await this.placeRepository.manager.query(
          `SELECT entity_id
             FROM ci.entities
            WHERE entity_type = 'Location'
              AND owner_user_id = $1
              AND properties->>'place_id' = $2
            LIMIT 1`,
          [context.userId, placeId],
        );

        if (winner.length > 0) {
          const id = winner[0].entity_id;
          await this.enrichResolvedPlace(context, id, input.lat, input.lng, placeId);
          await this.ensureHierarchy(context, id, input.components ?? null);

          return { id, created: false };
        }
      }

      // Otherwise unreachable in steady state: either the INSERT succeeded, or a
      // conflicting row already existed and the SELECT finds it. If we hit
      // this, the unique index and SELECT predicate have drifted apart.
      throw new Error(
        `findOrCreateForGeocode: failed to find or create place for "${trimmedName}" at (${latR}, ${lngR})`,
      );
    }

    const { entity_id, was_new } = rows[0];

    if (!was_new) {
      // Pre-existing row matched by snap cell: enrich it with what this
      // resolution knows (full-precision point if missing, the place_id claim).
      await this.enrichResolvedPlace(context, entity_id, input.lat, input.lng, placeId);
    }

    await this.ensureHierarchy(context, entity_id, input.components ?? null);

    if (was_new) {
      await this.graphDeltaWriter.entityCreated({
        entityId: entity_id,
        entityType: 'Location',
        name: trimmedName,
        ownerUserId: context.userId,
        changeSource: 'PlaceService.findOrCreateForGeocode',
        changedByUserId: typeof context.userId === 'string' ? context.userId : null,
      });
      await this.eventService.send(PlaceCreatedEvent, { placeId: entity_id });
    }

    return { id: entity_id, created: was_new };
  }

  /**
   * Create the Location backing a user-confirmed known place (home/work/...).
   *
   * Deliberately NOT routed through findOrCreateForGeocode: that path's
   * identity is the geocode namespace (`properties.source = 'reverse_geocode'`,
   * keyed on name + 3dp cell), and a hand-labelled cluster centroid is neither
   * geocoded nor stable under relabelling. Stamping it `known_place` keeps it
   * out of that dedupe namespace so a re-labelled confirm can't silently
   * collide with — or fork from — a geocoded place.
   */
  async createKnownPlaceLocation(
    context: UserServiceContext,
    input: { name: string; lat: number; lng: number },
  ): Promise<{ id: string }> {
    const id = uuidv7();

    await this.placeRepository.manager.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, location_point, place_kind)
       VALUES ($1, 'Location', $2, $3, $4::jsonb,
               ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, 'venue')`,
      [
        id,
        context.userId,
        input.name.trim(),
        JSON.stringify({ source: 'known_place', lat: input.lat, lng: input.lng }),
        input.lng,
        input.lat,
      ],
    );

    await this.eventService.send(PlaceCreatedEvent, { placeId: id });

    return { id };
  }

  /**
   * Backfill full-precision location_point (only when missing) and stamp the
   * provider place_id claim (only when unclaimed).
   *
   * The claim's NOT EXISTS guard is check-then-write across two statements, so
   * two concurrent resolutions of the same place_id against different rows can
   * both pass it and the loser raises 23505 on
   * entities_place_provider_id_uniq. That IS the intended outcome (one row owns
   * the id) — swallow it so the caller still gets its place link, matching the
   * "duplicate claim is a no-op, never an error" contract.
   */
  private async enrichResolvedPlace(
    context: UserServiceContext,
    entityId: string,
    lat: number,
    lng: number,
    placeId: string | null,
  ): Promise<void> {
    await this.placeRepository.manager.query(
      `UPDATE ci.entities
          SET location_point = COALESCE(location_point, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography),
              place_kind = COALESCE(place_kind, 'address')
        WHERE entity_id = $1 AND owner_user_id = $2`,
      [entityId, context.userId, lng, lat],
    );

    if (placeId) {
      try {
        await this.placeRepository.manager.query(
          `UPDATE ci.entities e
              SET properties = properties || jsonb_build_object('place_id', $3::text)
            WHERE e.entity_id = $1 AND e.owner_user_id = $2
              AND e.properties->>'place_id' IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM ci.entities other
                 WHERE other.owner_user_id = $2
                   AND other.entity_type = 'Location'
                   AND other.properties->>'place_id' = $3
                   AND other.entity_id <> $1
              )`,
          [entityId, context.userId, placeId],
        );
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // Another row won the claim between the guard and the write — exactly
        // what the guard was trying to detect.
      }
    }
  }

  /**
   * Build the geographic containment chain for a resolved place from the
   * geocode provider's address components: find-or-create city -> region ->
   * country nodes (deduped per parent via entities_admin_place_uniq) and link
   * parent_place_id pointers, then hang the place under the most specific
   * admin node found. Best-effort: any failure leaves the place unparented
   * rather than failing the geocode.
   */
  async ensureHierarchy(
    context: UserServiceContext,
    entityId: string,
    components: Record<string, unknown> | null,
  ): Promise<void> {
    const list = (components as { address_components?: unknown } | null)?.address_components;
    if (!Array.isArray(list) || list.length === 0) {
      return;
    }

    try {
      // Extract one name per hierarchy level, most-specific first.
      const levels: Array<{ kind: PlaceKind; name: string }> = [];
      for (const { componentType, kind } of COMPONENT_HIERARCHY) {
        const match = (list as AddressComponent[]).find(
          (component) =>
            Array.isArray(component.types) &&
            component.types.includes(componentType) &&
            typeof component.long_name === 'string' &&
            component.long_name.trim() !== '',
        );

        if (match) {
          levels.push({ kind, name: match.long_name!.trim() });
        }
      }

      if (levels.length === 0) {
        return;
      }

      // Walk top-down (country -> region -> city), find-or-create each node and
      // chain parents as we go.
      let parentId: string | null = null;
      for (const level of [...levels].reverse()) {
        parentId = await this.findOrCreateAdminPlace(context, level.kind, level.name, parentId);
      }

      // Hang the place under the most specific admin node (never itself — an
      // admin-level place can resolve to its own hierarchy node).
      if (parentId && parentId !== entityId) {
        await this.placeRepository.manager.query(
          `UPDATE ci.entities
              SET parent_place_id = $3
            WHERE entity_id = $1 AND owner_user_id = $2 AND parent_place_id IS NULL`,
          [entityId, context.userId, parentId],
        );
      }
    } catch {
      // Hierarchy is enrichment — never fail the resolution over it.
    }
  }

  /**
   * Find-or-create one admin-level hierarchy node, keyed on
   * (owner, kind, lower(name), parent) via entities_admin_place_uniq. Also
   * links the node's own parent pointer when it was created unparented first.
   */
  private async findOrCreateAdminPlace(
    context: UserServiceContext,
    kind: PlaceKind,
    name: string,
    parentId: string | null,
  ): Promise<string> {
    // Adopt an existing UNPARENTED node of the same kind+name before inserting.
    // Providers return partial address_components (a result with locality but
    // no admin_area_level_1 is common outside the US), so the same city can be
    // resolved first without a parent and later with one; without this the
    // keyed lookup below would miss and mint a duplicate city node.
    if (parentId) {
      const adopted: Array<{ entity_id: string }> = await this.placeRepository.manager.query(
        `UPDATE ci.entities
            SET parent_place_id = $4
          WHERE entity_id = (
            SELECT entity_id
              FROM ci.entities
             WHERE entity_type = 'Location'
               AND owner_user_id = $1
               AND place_kind = $2
               AND lower(btrim(name)) = lower(btrim($3))
               AND parent_place_id IS NULL
             ORDER BY created_at ASC
             LIMIT 1)
          RETURNING entity_id`,
        [context.userId, kind, name, parentId],
      );

      if (adopted.length > 0) {
        return adopted[0].entity_id;
      }
    }

    const newId = uuidv7();

    await this.placeRepository.manager.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, place_kind, parent_place_id)
       VALUES ($1, 'Location', $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT DO NOTHING`,
      [newId, context.userId, name, JSON.stringify({ source: 'geocode_hierarchy' }), kind, parentId],
    );

    const rows: Array<{ entity_id: string }> = await this.placeRepository.manager.query(
      `SELECT entity_id
         FROM ci.entities
        WHERE entity_type = 'Location'
          AND owner_user_id = $1
          AND place_kind = $2
          AND lower(btrim(name)) = lower(btrim($3))
          AND COALESCE(parent_place_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        LIMIT 1`,
      [context.userId, kind, name, parentId],
    );

    if (rows.length === 0) {
      throw new Error(`findOrCreateAdminPlace: failed to resolve ${kind} "${name}"`);
    }

    return rows[0].entity_id;
  }

  /**
   * Places within `radiusMeters` of a point, nearest first. Runs on the
   * partial GIST index over location_point (geography ST_DWithin measures
   * meters directly).
   */
  async placesNear(
    context: UserServiceContext,
    input: { lat: number; lng: number; radiusMeters: number; limit?: number },
  ): Promise<Array<Place & { distanceMeters: number }>> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
    const radius = Math.min(Math.max(input.radiusMeters, 1), 20_000_000);

    const rows: Array<{ entity_id: string; distance_meters: string }> =
      await this.placeRepository.manager.query(
        `SELECT entity_id,
                ST_Distance(location_point, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) AS distance_meters
           FROM ci.entities
          WHERE entity_type = 'Location'
            AND owner_user_id = $1
            AND location_point IS NOT NULL
            AND ST_DWithin(location_point, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
          ORDER BY distance_meters ASC
          LIMIT $5`,
        [context.userId, input.lng, input.lat, radius, limit],
      );

    if (rows.length === 0) {
      return [];
    }

    const places = await this.findByIds(
      context,
      rows.map((row) => row.entity_id),
    );

    const out: Array<Place & { distanceMeters: number }> = [];
    rows.forEach((row, index) => {
      const place = places[index];
      if (place) {
        out.push({ ...place, distanceMeters: Number(row.distance_meters) });
      }
    });

    return out;
  }

  /**
   * Aggregated visit stats for a batch of places from events.location_entity_id
   * (indexed by events_location_entity_idx). One grouped query per batch.
   */
  async getVisitStats(context: ServiceContext, placeIds: string[]): Promise<Map<string, PlaceVisitStats>> {
    const out = new Map<string, PlaceVisitStats>();
    if (placeIds.length === 0) {
      return out;
    }

    for (const id of placeIds) {
      out.set(id, { visitCount: 0, firstVisitAt: null, lastVisitAt: null });
    }

    const rows: Array<{ place_id: string; n: string; first_at: Date | null; last_at: Date | null }> =
      await this.placeRepository.manager.query(
        `SELECT location_entity_id AS place_id,
                COUNT(*) AS n,
                MIN(start_time) AS first_at,
                MAX(start_time) AS last_at
           FROM ci.events
          WHERE user_id = $1 AND location_entity_id = ANY($2::uuid[])
          GROUP BY location_entity_id`,
        [context.userId, placeIds],
      );

    for (const row of rows) {
      out.set(row.place_id, {
        visitCount: Number(row.n),
        firstVisitAt: row.first_at,
        lastVisitAt: row.last_at,
      });
    }

    return out;
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

        if (item.parentPlaceId) {
          await this.assertParentPlace(context, id, item.parentPlaceId);
        }

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

        // save() does not fire @AfterLoad, so the derived fields (latitude,
        // longitude, type, geoFormat, ...) would egress as null even though
        // they were just persisted. Populate them from the saved row.
        placeResult.loadPropertiesFromJsonb();

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

  /** List places; `query` filters by name (ILIKE substring). */
  async findAll(context: UserServiceContext, options: { query?: string } = {}): Promise<Place[]> {
    let qb = this.placeRepository
      .createQueryBuilder('place')
      .leftJoinAndSelect('place.user', 'user')
      .where('place.entity_type = :entityType', { entityType: 'Location' })
      .andWhere('place.owner_user_id = :userId', { userId: context.userId });

    const query = options.query?.trim();
    if (query) {
      qb = qb.andWhere('place.name ILIKE :q', { q: `%${query}%` });
    }

    const rows = await qb
      .orderBy(`NULLIF(btrim(COALESCE(place.name, '')), '')`, 'ASC', 'NULLS LAST')
      .addOrderBy('place.created_at', 'DESC')
      .getMany();

    return rows.map((row) => PlaceEntity.toEgressType(row));
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

  /**
   * Validate a caller-supplied parent place id before it reaches the
   * parent_place_id FK. GlobalUIDs are unsigned base64, so the id is fully
   * client-controlled: an unchecked value can reference a nonexistent row (FK
   * violation surfacing as a 500 and doubling as an existence oracle), ANOTHER
   * user's entity (cross-tenant edge that their delete would silently mutate
   * via ON DELETE SET NULL), a non-Location entity, or the place itself.
   */
  private async assertParentPlace(
    context: ServiceContext,
    placeId: string | null,
    parentPlaceId: string,
  ): Promise<string> {
    if (placeId != null && parentPlaceId === placeId) {
      throw new BadRequestException('A place cannot be its own parent');
    }

    const rows: Array<{ entity_id: string }> = await this.placeRepository.manager.query(
      `SELECT entity_id
         FROM ci.entities
        WHERE entity_id = $1 AND entity_type = 'Location'
          AND ($2::uuid IS NULL OR owner_user_id = $2)
        LIMIT 1`,
      [parentPlaceId, context.userId === SYSTEM_USER ? null : context.userId],
    );

    if (rows.length === 0) {
      throw new BadRequestException('Parent place not found');
    }

    return rows[0].entity_id;
  }

  async update(context: ServiceContext, id: string, data: UpdatePlaceDto): Promise<Place | null> {
    const { properties, latitude, longitude, place_kind, parent_place_id, ...rest } = data;

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

      // Typed place columns: only touch what was provided.
      const typed: Partial<Pick<PlaceEntity, 'locationPoint' | 'placeKind' | 'parentPlaceId'>> = {};
      if (typeof latitude === 'number' && typeof longitude === 'number') {
        typed.locationPoint = { type: 'Point', coordinates: [longitude, latitude] };
      }

      if (place_kind !== undefined) {
        typed.placeKind = place_kind ?? null;
      }

      if (parent_place_id !== undefined) {
        typed.parentPlaceId = parent_place_id
          ? await this.assertParentPlace(context, id, parent_place_id)
          : null;
      }

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
          ...typed,
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

    // Re-parent children to the deleted node's own parent BEFORE deleting.
    // parent_place_id is ON DELETE SET NULL, and nulling an admin child's
    // parent can collide with a parentless same-name node on
    // entities_admin_place_uniq — which would abort the cascade and make the
    // place undeletable. Grafting also preserves the containment chain
    // (city keeps its country when the region is removed).
    await this.placeRepository.manager.query(
      `UPDATE ci.entities
          SET parent_place_id = $3
        WHERE parent_place_id = $1
          AND ($2::uuid IS NULL OR owner_user_id = $2)`,
      [id, context.userId === SYSTEM_USER ? null : context.userId, place.parentPlaceId ?? null],
    );

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
