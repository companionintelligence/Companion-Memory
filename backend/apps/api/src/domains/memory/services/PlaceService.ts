import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { isUniqueViolation } from '@ci/common/constants';
import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { computeChunkSize } from '@ci/common/persistence';
import { isGeocodingConfigured } from '@ci/configuration';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { PlaceEntity, type Place, type PlaceKind } from '../entities/PlaceEntity';
import { PlaceCreatedEvent, PlaceUpdatedEvent, PlaceRemovedEvent } from '../events';
import type { CreatePlaceDto, UpdatePlaceDto } from '../types';

import {
  appearanceParams,
  appearanceWindowParams,
  hasDateWindow,
  mapAppearanceRows,
  ownerUserId,
  placeAppearanceCountSql,
  placeAppearanceListSql,
} from './appearanceBrowse';
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
  /**
   * `confirmed`: this IS a fact about the place. `pending_enrichment`: this
   * zero is not yet a measurement — geocoding isn't configured, or place
   * promotion for this user has work outstanding, so an event that WILL
   * eventually count as a visit here just hasn't been linked yet. A place
   * with a non-zero visitCount is always `confirmed` — enrichment being
   * behind cannot make an already-counted visit less real.
   */
  status: 'confirmed' | 'pending_enrichment';
}

/**
 * How far apart two same-named resolutions can be and still be one place.
 *
 * The snap-cell index below dedupes on a 0.001° grid (~90 m east–west at
 * mid-latitudes), which has a boundary problem: two pickups 80 m apart at the
 * same street address straddle a cell edge and become two Locations named
 * identically. A name that matches byte-for-byte within this radius is the
 * same place — a different venue sharing a name ("Starbucks") sits far
 * further away than this. Same figure the Places page uses to decide a
 * candidate IS an already-confirmed place.
 */
const SAME_NAME_MERGE_METRES = 150;

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
      /**
       * Provider bounding box, when the resolved feature HAS an extent (a city,
       * neighbourhood or park — never a street address). Stored as the place's
       * polygon footprint so containment queries can answer "which place is
       * this coordinate inside?". Structural shape rather than the geocode
       * domain's GeocodeBounds so memory does not import geocode (the
       * dependency already runs the other way, via GeocodeBatchListener).
       */
      bounds?: { north: number; south: number; east: number; west: number } | null;
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
        await this.enrichResolvedPlace(context, id, input.lat, input.lng, placeId, input.bounds);
        await this.ensureHierarchy(context, id, input.components ?? null);

        return { id, created: false };
      }
    }

    // 1b. Same name, close by: the provider gave no place_id (or a different
    // one) but an identically named Location already sits within walking
    // distance. The snap-cell index cannot catch this when the two points
    // fall either side of a cell edge, so check proximity explicitly.
    const byNameNearby: Array<{ entity_id: string }> = await this.placeRepository.manager.query(
      `SELECT entity_id
         FROM ci.entities
        WHERE entity_type = 'Location'
          AND owner_user_id = $1
          AND merged_into_entity_id IS NULL
          AND is_active IS DISTINCT FROM FALSE
          AND lower(btrim(name)) = lower($2)
          AND location_point IS NOT NULL
          AND ST_DWithin(location_point, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5)
        ORDER BY ST_Distance(location_point, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)
        LIMIT 1`,
      [context.userId, trimmedName, input.lng, input.lat, SAME_NAME_MERGE_METRES],
    );

    if (byNameNearby.length > 0) {
      const id = byNameNearby[0].entity_id;
      await this.enrichResolvedPlace(context, id, input.lat, input.lng, placeId, input.bounds);
      await this.ensureHierarchy(context, id, input.components ?? null);

      return { id, created: false };
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
    // A bounded feature is an area, not an address: keep place_kind honest so
    // the hierarchy and the UI don't label a whole city "address".
    const bounds = normalizeBounds(input.bounds);

    await this.placeRepository.manager.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, location_point, place_kind, location_boundary)
       VALUES ($1, 'Location', $2, $3, $4::jsonb,
               ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7,
               CASE WHEN $8::boolean
                    THEN ST_MakeEnvelope($9, $10, $11, $12, 4326)::geography
                    ELSE NULL END)
       ON CONFLICT DO NOTHING`,
      [
        newId,
        context.userId,
        trimmedName,
        JSON.stringify(properties),
        input.lng,
        input.lat,
        bounds ? 'neighborhood' : 'address',
        bounds != null,
        bounds?.west ?? 0,
        bounds?.south ?? 0,
        bounds?.east ?? 0,
        bounds?.north ?? 0,
      ],
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
          await this.enrichResolvedPlace(context, id, input.lat, input.lng, placeId, input.bounds);
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
      await this.enrichResolvedPlace(context, entity_id, input.lat, input.lng, placeId, input.bounds);
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
    const name = normalizePlaceName(input.name);
    const id = uuidv7();

    try {
      await this.placeRepository.manager.query(
        `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, location_point, place_kind)
         VALUES ($1, 'Location', $2, $3, $4::jsonb,
                 ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, 'venue')`,
        [
          id,
          context.userId,
          name,
          JSON.stringify({ source: 'known_place', lat: input.lat, lng: input.lng }),
          input.lng,
          input.lat,
        ],
      );
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }

      // A geocoded place already owns this name in the same cell. Naming the
      // cluster should land on that row, the same way findOrCreateForGeocode
      // converges a rename, instead of surfacing the unique-index failure as
      // an internal server error.
      const existing: Array<{ entity_id: string }> = await this.placeRepository.manager.query(
        `SELECT entity_id
           FROM ci.entities
          WHERE entity_type = 'Location'
            AND owner_user_id = $1
            AND merged_into_entity_id IS NULL
            AND lower(btrim(name)) = lower(btrim($2))
            AND location_point IS NOT NULL
            AND ST_DWithin(
                  location_point,
                  ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
                  $5)
          LIMIT 1`,
        [context.userId, name, input.lng, input.lat, SAME_NAME_MERGE_METRES],
      );

      if (existing.length > 0) {
        return { id: existing[0].entity_id };
      }

      throw new ConflictException(
        'A place with that name already exists nearby. Choose a different name, or edit the existing place.',
      );
    }

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
    rawBounds?: { north: number; south: number; east: number; west: number } | null,
  ): Promise<void> {
    // COALESCE throughout: enrichment only FILLS gaps. A boundary a user drew
    // by hand, or a tighter one from an earlier resolution, is never replaced
    // by a provider box.
    const bounds = normalizeBounds(rawBounds);

    await this.placeRepository.manager.query(
      `UPDATE ci.entities
          SET location_point = COALESCE(location_point, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography),
              place_kind = COALESCE(place_kind, 'address'),
              location_boundary = COALESCE(
                location_boundary,
                CASE WHEN $5::boolean
                     THEN ST_MakeEnvelope($6, $7, $8, $9, 4326)::geography
                     ELSE NULL END)
        WHERE entity_id = $1 AND owner_user_id = $2`,
      [
        entityId,
        context.userId,
        lng,
        lat,
        bounds != null,
        bounds?.west ?? 0,
        bounds?.south ?? 0,
        bounds?.east ?? 0,
        bounds?.north ?? 0,
      ],
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
    //
    // Read back through a CTE: a bare UPDATE … RETURNING resolves to the pair
    // [rows, rowCount], whose length is always 2 and whose [0] is the rows
    // array — so every call with a parent used to return `undefined` without
    // minting the node, and the chain broke below it (see
    // __tests__/PlaceService.hierarchy.integration.spec.ts).
    if (parentId) {
      const adopted: Array<{ entity_id: string }> = await this.placeRepository.manager.query(
        `WITH adopted AS (
           UPDATE ci.entities
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
            RETURNING entity_id
         )
         SELECT entity_id FROM adopted`,
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
   * Places whose polygon footprint COVERS the given point, most specific
   * (smallest area) first — "which place am I inside?", the containment
   * counterpart to {@link placesNear}'s proximity search.
   *
   * Runs on entities_location_boundary_gix. ST_Covers (not ST_Contains) so a
   * point exactly on the boundary edge counts as inside — a coordinate landing
   * on a city limit belongs to that city rather than to nowhere.
   *
   * Only places that actually HAVE a footprint can match: a venue known only as
   * a point is not a container. Ordering by area means a park inside a city
   * outranks the city.
   */
  async placesContaining(
    context: UserServiceContext,
    input: { lat: number; lng: number; limit?: number },
  ): Promise<Place[]> {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);

    const rows: Array<{ entity_id: string }> = await this.placeRepository.manager.query(
      `SELECT entity_id
         FROM ci.entities
        WHERE entity_type = 'Location'
          AND owner_user_id = $1
          AND location_boundary IS NOT NULL
          AND ST_Covers(location_boundary, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography)
        ORDER BY ST_Area(location_boundary) ASC
        LIMIT $4`,
      [context.userId, input.lng, input.lat, limit],
    );

    if (rows.length === 0) {
      return [];
    }

    const places = await this.findByIds(
      context,
      rows.map((row) => row.entity_id),
    );

    return places.filter((place): place is Place => place != null);
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

    // A zero-visit place is `pending_enrichment`, not a confirmed fact, when
    // either (a) geocoding isn't configured — ENRICH_GEOCODE can never run,
    // so PROMOTE_PLACE never gets a location_coordinates to work from — or
    // (b) this user has enrich.geocode/promote.place work that hasn't
    // finished. One cheap existence query per BATCH (not per place) so this
    // never turns into an N+1.
    const pending =
      !isGeocodingConfigured() ||
      (
        await this.placeRepository.manager.query(
          `SELECT EXISTS (
             SELECT 1 FROM ci.pipeline_state
              WHERE user_id = $1
                AND stage IN ('enrich.geocode', 'promote.place')
                AND status IN ('pending', 'failed', 'running')
           ) AS exists`,
          [context.userId],
        )
      )[0].exists;

    for (const id of placeIds) {
      out.set(id, {
        visitCount: 0,
        firstVisitAt: null,
        lastVisitAt: null,
        status: pending ? 'pending_enrichment' : 'confirmed',
      });
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
      // A place with at least one counted visit is confirmed regardless of
      // outstanding enrichment elsewhere — this specific number is real.
      out.set(row.place_id, {
        visitCount: Number(row.n),
        firstVisitAt: row.first_at,
        lastVisitAt: row.last_at,
        status: 'confirmed',
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
   *
   * With no date window this is the unique places list, ordered by row-write
   * time. With a date window the list is places that were actually visited in
   * that window, ordered by first real visit in it — not `created_at`.
   */
  async getEntitiesForPlaces(
    context: ServiceContext,
    options: {
      limit?: number;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      order?: 'ASC' | 'DESC';
    } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    if (hasDateWindow(options)) {
      return this.listPlacesByAppearance(context, options);
    }

    let query = this.placeRepository
      .createQueryBuilder('place')
      .select('place.id', 'id')
      .where('place.entity_type = :entityType', { entityType: 'Location' })
      .andWhere('place.owner_user_id = :userId', { userId: context.userId });

    // Composite keyset: page strictly past (afterTime, afterId) in
    // (updated_at DESC, entity_id DESC) — see ContentService.getEntitiesForContents.
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        '(place.updated_at < :afterTime OR (place.updated_at = :afterTime AND place.entity_id < :afterId))',
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    // Deterministic tiebreak so same-timestamp rows page consistently.
    query = query.orderBy('place.updated_at', options.order ?? 'DESC').addOrderBy('place.entity_id', 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'place' as IndexableEntity }));
  }

  /**
   * Date-windowed Places browse: one row per place, timestamped at MIN(event
   * start_time in the window) where this place is `location_entity_id`. Ingest
   * wall-clock events are excluded. Places with no real visit in the window
   * drop out. See appearanceBrowse.ts.
   */
  private async listPlacesByAppearance(
    context: ServiceContext,
    options: {
      limit?: number;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      order?: 'ASC' | 'DESC';
    },
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const userId = ownerUserId(context.userId);
    if (userId == null) {
      return [];
    }

    const rows = await this.placeRepository.manager.query<Array<{ id: string; appearedAt: Date | string }>>(
      placeAppearanceListSql(options.order ?? 'DESC'),
      appearanceParams(userId, options),
    );

    return mapAppearanceRows(rows, 'place');
  }

  /**
   * True total of places matching the same filters {@link getEntitiesForPlaces} applies (minus
   * the pagination-only `limit`/`order`/`afterTime`/`afterId`) — a real `COUNT(*)`, not the
   * length of one `limit`-bounded page of identifiers. See CalendarEventService.countEntitiesForEvents.
   */
  async countEntitiesForPlaces(
    context: ServiceContext,
    options: { startTime?: Date; endTime?: Date },
  ): Promise<number> {
    if (hasDateWindow(options)) {
      const userId = ownerUserId(context.userId);
      if (userId == null) {
        return 0;
      }

      const rows = await this.placeRepository.manager.query<Array<{ n: number }>>(
        placeAppearanceCountSql(),
        appearanceWindowParams(userId, options),
      );

      return Number(rows[0]?.n ?? 0);
    }

    let query = this.placeRepository
      .createQueryBuilder('place')
      .where('place.entity_type = :entityType', { entityType: 'Location' })
      .andWhere('place.owner_user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('place.updated_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('place.updated_at <= :endTime', { endTime: options.endTime });
    }

    return query.getCount();
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
      // entities_reverse_geocode_dedup_idx casts properties.lat/lng to numeric
      // on every update of a geocoded place. A non-numeric value (a degree
      // mark, a label that landed in the coordinate field) aborts the UPDATE
      // with 22P02, which the GraphQL layer masks as "Internal server error".
      // Coerce what we can and drop the rest so a rename still saves; the
      // typed location_point column keeps the real coordinate.
      sanitizeGeocodeCoordinates(props);

      if (typeof rest.name === 'string') {
        rest.name = normalizePlaceName(rest.name);
      }

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

      let result: { affected?: number | null };

      try {
        result = await this.placeRepository.update(
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
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'A place with that name already exists at this location. Choose a different name, or edit the existing place.',
          );
        }

        throw err;
      }

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

/**
 * Validate a provider bounding box before it becomes a polygon. Rejects
 * non-finite corners, a zero-area or inverted box, and one crossing the
 * antimeridian (east <= west) — ST_MakeEnvelope would otherwise build an
 * envelope wrapping most of the globe, which would then "contain" every
 * coordinate the user has.
 */
/**
 * A place name is free text: apostrophes, accents, and symbols are stored as
 * typed. The only values Postgres rejects inside `text` are null bytes, and an
 * empty name is not a useful rename. Both used to fall through to a masked
 * internal server error.
 */
function normalizePlaceName(name: string): string {
  if (name.includes('\u0000')) {
    throw new BadRequestException('A place name can’t include a null character.');
  }

  const trimmed = name.trim();

  if (trimmed === '') {
    throw new BadRequestException('A place name can’t be empty.');
  }

  return trimmed;
}

/**
 * Keep `properties.lat` / `properties.lng` numeric so the reverse-geocode
 * unique index can evaluate them. Non-numeric leftovers are removed.
 */
function sanitizeGeocodeCoordinates(props: Record<string, unknown>): void {
  for (const key of ['lat', 'lng'] as const) {
    if (!(key in props)) {
      continue;
    }

    const coerced = coerceStoredCoordinate(props[key]);

    if (coerced === undefined) {
      delete props[key];
    } else {
      props[key] = coerced;
    }
  }
}

function coerceStoredCoordinate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim().replace(/°/g, '');

  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    return undefined;
  }

  const numeric = Number(trimmed);

  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeBounds(
  bounds: { north: number; south: number; east: number; west: number } | null | undefined,
): { north: number; south: number; east: number; west: number } | null {
  if (!bounds) {
    return null;
  }

  const { north, south, east, west } = bounds;

  if (![north, south, east, west].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }

  if (north <= south || east <= west) {
    return null;
  }

  if (north > 90 || south < -90 || east > 180 || west < -180) {
    return null;
  }

  return { north, south, east, west };
}
