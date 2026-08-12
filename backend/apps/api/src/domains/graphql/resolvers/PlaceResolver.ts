import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, Float, ID, Int, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MaxArraySizePipe } from '@ci/common/pipes';
import { GraphQueryService, type PlaceKind, PlaceService } from '@ci/domains/memory';

import { PlaceLoader } from '../loaders/PlaceLoader';
import { PlaceVisitStatsLoader } from '../loaders/PlaceVisitStatsLoader';
import { TagLoader } from '../loaders/TagLoader';
import { CreatePlaceInput } from '../types/CreatePlaceInput';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { PlaceConnection } from '../types/PlaceConnection';
import { PlaceEdge } from '../types/PlaceEdge';
import { PlaceNearType } from '../types/PlaceNearType';
import { PlaceType } from '../types/PlaceType';
import { PlaceVisitStatsType } from '../types/PlaceVisitStatsType';
import { RelationshipType } from '../types/RelationshipType';
import { UpdatePlaceInput } from '../types/UpdatePlaceInput';
import { memoryRelToGql } from '../utils/lifeGraphRelationships';
import { Paginator } from '../utils/Paginator';

const PLACE_KINDS: PlaceKind[] = [
  'room',
  'building',
  'venue',
  'address',
  'neighborhood',
  'city',
  'region',
  'country',
  'continent',
  'planet',
  'other',
];

/**
 * Validate a caller-supplied place kind. Unknown values are rejected rather
 * than silently dropped — the DB has a matching valid_place_kind CHECK, and a
 * discarded write with a success payload is indistinguishable from a stored one.
 */
function parsePlaceKind(raw: string | undefined | null): PlaceKind | undefined {
  if (raw == null) {
    return undefined;
  }

  if (!(PLACE_KINDS as string[]).includes(raw)) {
    throw new BadRequestException(`Unknown placeKind "${raw}" — expected one of: ${PLACE_KINDS.join(', ')}`);
  }

  return raw as PlaceKind;
}

/**
 * Resolve typed coordinates for location_point. Prefer explicit lat/lng; fall
 * back to a legacy geolocation array [lng, lat]. Never write geolocation into
 * properties — location_point is canonical (Wave C location dedup).
 */
function locationPointFromPlaceInput(input: {
  latitude?: number | null;
  longitude?: number | null;
  geolocation?: unknown;
}): { type: 'Point'; coordinates: [number, number] } | undefined {
  if (typeof input.latitude === 'number' && typeof input.longitude === 'number') {
    return { type: 'Point' as const, coordinates: [input.longitude, input.latitude] };
  }

  if (Array.isArray(input.geolocation) && input.geolocation.length >= 2) {
    const lng = Number(input.geolocation[0]);
    const lat = Number(input.geolocation[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { type: 'Point' as const, coordinates: [lng, lat] };
    }
  }

  return undefined;
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => PlaceType)
export class PlaceResolver {
  constructor(
    private readonly placeService: PlaceService,
    private readonly placeLoader: PlaceLoader,
    private readonly placeVisitStatsLoader: PlaceVisitStatsLoader,
    private readonly tagLoader: TagLoader,
    private readonly graphQuery: GraphQueryService,
  ) {}

  @Mutation(() => PlaceType)
  async createPlace(
    @Context() context: RequestContext,
    @Args('input') input: CreatePlaceInput,
  ): Promise<PlaceType> {
    const serviceContext = toServiceContext(context);

    const properties = input.properties || {};

    if (input.type) {
      properties.type = input.type;
    }

    if (input.geoFormat) {
      properties.geoFormat = input.geoFormat;
    }

    // Do not write properties.geolocation — use location_point (typed columns).

    if (input.locationBoundary) {
      properties.locationBoundary = input.locationBoundary;
    }

    if (input.estimated) {
      properties.estimated = input.estimated;
    }

    if (input.tracked) {
      properties.tracked = input.tracked;
    }

    if (input.uploaded) {
      properties.uploaded = input.uploaded;
    }

    const locationPoint = locationPointFromPlaceInput(input);

    const entity = await this.placeService.create(serviceContext, {
      name: input.name,
      entity_type: 'Location',
      properties,
      description: input.description,
      ...(locationPoint ? { locationPoint } : {}),
      ...(input.placeKind != null ? { placeKind: parsePlaceKind(input.placeKind) } : {}),
      ...(input.parentId ? { parentPlaceId: GlobalUID.parse('place', input.parentId) } : {}),
    });

    return PlaceType.toType(entity[0]);
  }

  /**
   * Batch create places in one round-trip. The clean batch equivalent of N
   * aliased createPlace mutations; returns the created rows in input order.
   */
  @Mutation(() => [PlaceType])
  async createPlaces(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreatePlaceInput] }, new MaxArraySizePipe())
    input: CreatePlaceInput[],
  ): Promise<PlaceType[]> {
    const serviceContext = toServiceContext(context);

    const places = await this.placeService.createMany(
      serviceContext,
      input.map((item) => {
        const properties = item.properties || {};

        if (item.type) {
          properties.type = item.type;
        }

        if (item.geoFormat) {
          properties.geoFormat = item.geoFormat;
        }

        // Do not write properties.geolocation — use location_point (typed columns).

        if (item.locationBoundary) {
          properties.locationBoundary = item.locationBoundary;
        }

        if (item.estimated) {
          properties.estimated = item.estimated;
        }

        if (item.tracked) {
          properties.tracked = item.tracked;
        }

        if (item.uploaded) {
          properties.uploaded = item.uploaded;
        }

        const locationPoint = locationPointFromPlaceInput(item);

        return {
          name: item.name,
          entity_type: 'Location',
          properties,
          description: item.description,
          ...(locationPoint ? { locationPoint } : {}),
          ...(item.placeKind != null ? { placeKind: parsePlaceKind(item.placeKind) } : {}),
          ...(item.parentId ? { parentPlaceId: GlobalUID.parse('place', item.parentId) } : {}),
        };
      }),
    );

    return places.map((place) => PlaceType.toType(place));
  }

  @Mutation(() => PlaceType, { nullable: true })
  async updatePlace(
    @Context() context: RequestContext,
    @Args('input') input: UpdatePlaceInput,
  ): Promise<PlaceType | null> {
    const serviceContext = toServiceContext(context);

    const properties = input.properties || {};

    if (input.type) {
      properties.type = input.type;
    }

    if (input.geoFormat) {
      properties.geoFormat = input.geoFormat;
    }

    // Do not write properties.geolocation — use location_point (typed columns).

    if (input.locationBoundary) {
      properties.locationBoundary = input.locationBoundary;
    }

    if (input.estimated) {
      properties.estimated = input.estimated;
    }

    if (input.tracked) {
      properties.tracked = input.tracked;
    }

    if (input.uploaded) {
      properties.uploaded = input.uploaded;
    }

    const id = GlobalUID.parse('place', input.id);
    const locationPoint = locationPointFromPlaceInput(input);

    const entity = await this.placeService.update(serviceContext, id, {
      name: input.name,
      properties,
      description: input.description,
      ...(locationPoint
        ? { latitude: locationPoint.coordinates[1], longitude: locationPoint.coordinates[0] }
        : {}),
      // An explicit empty string clears the kind; a value is validated.
      ...(input.placeKind !== undefined
        ? { place_kind: input.placeKind === '' ? null : parsePlaceKind(input.placeKind) }
        : {}),
      ...(input.parentId !== undefined
        ? { parent_place_id: input.parentId ? GlobalUID.parse('place', input.parentId) : null }
        : {}),
    });

    return entity ? PlaceType.toType(entity) : entity;
  }

  @Mutation(() => Boolean)
  async removePlace(@Context() context: RequestContext, @Args('id') id: string): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    return this.placeService.remove(serviceContext, id);
  }

  @Query(() => PlaceConnection)
  async places(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
    @Args('query', { type: () => String, nullable: true }) query?: string,
  ): Promise<PlaceConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.placeService.findAll(serviceContext, { query: query ?? undefined });

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('place', entity.id),
    });

    const edges: PlaceEdge[] = slice.map((entity) => {
      const node = PlaceType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  @Query(() => PlaceType, { nullable: true })
  async place(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<PlaceType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('place', gid);

    const entity = await this.placeService.findById(serviceContext, id);

    return entity ? PlaceType.toType(entity) : null;
  }

  /**
   * Places within radiusMeters of a point, nearest first — runs on the
   * location_point GIST index (issue #1811 GIS lookups).
   */
  @Query(() => [PlaceNearType])
  async placesNear(
    @Context() context: RequestContext,
    @Args('latitude', { type: () => Float }) latitude: number,
    @Args('longitude', { type: () => Float }) longitude: number,
    @Args('radiusMeters', { type: () => Float, nullable: true }) radiusMeters?: number,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<PlaceNearType[]> {
    const serviceContext = toServiceContext(context);

    const results = await this.placeService.placesNear(serviceContext, {
      lat: latitude,
      lng: longitude,
      radiusMeters: radiusMeters ?? 1000,
      limit: limit ?? undefined,
    });

    return results.map(({ distanceMeters, ...place }) => ({
      place: PlaceType.toType(place),
      distanceMeters,
    }));
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: PlaceType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'place',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }

  /** Aggregated event visit stats for this place (events.location_entity_id). */
  @ResolveField(() => PlaceVisitStatsType)
  async visitStats(
    @Context() context: RequestContext,
    @Parent() parent: PlaceType,
  ): Promise<PlaceVisitStatsType> {
    const serviceContext = toServiceContext(context);

    const stats = await this.placeVisitStatsLoader.load(serviceContext, parent.__source.id);

    return PlaceVisitStatsType.toType(stats);
  }

  /** The containing place (city/region/country chain), when known. */
  @ResolveField(() => PlaceType, { nullable: true })
  async parent(@Context() context: RequestContext, @Parent() parent: PlaceType): Promise<PlaceType | null> {
    const parentPlaceId = parent.__source.parentPlaceId;
    if (!parentPlaceId) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const place = await this.placeLoader.load(serviceContext, parentPlaceId);

    return place ? PlaceType.toType(place) : null;
  }

  /** Outbound life-graph edges from this place. */
  @ResolveField(() => [RelationshipType])
  async outgoingRelationships(
    @Context() context: RequestContext,
    @Parent() parent: PlaceType,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<RelationshipType[]> {
    const serviceContext = toServiceContext(context);
    if (typeof serviceContext.userId !== 'string') {
      return [];
    }

    const rows = await this.graphQuery.getRelationships(serviceContext.userId, {
      entityIds: [parent.__source.id],
      direction: 'outbound',
    });

    return rows.slice(0, limit ?? 50).map((row) => memoryRelToGql(row));
  }

  /** Inbound life-graph edges to this place (visits, located_at, …). */
  @ResolveField(() => [RelationshipType])
  async incomingRelationships(
    @Context() context: RequestContext,
    @Parent() parent: PlaceType,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<RelationshipType[]> {
    const serviceContext = toServiceContext(context);
    if (typeof serviceContext.userId !== 'string') {
      return [];
    }

    const rows = await this.graphQuery.getRelationships(serviceContext.userId, {
      entityIds: [parent.__source.id],
      direction: 'inbound',
    });

    return rows.slice(0, limit ?? 50).map((row) => memoryRelToGql(row));
  }
}
