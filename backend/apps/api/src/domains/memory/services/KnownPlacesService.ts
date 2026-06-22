import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

/** Role a known place plays in the user's life. */
export type KnownPlaceKind = 'home' | 'work' | 'school' | 'social' | 'other';

/** How a known-place assertion was established. */
export type KnownPlaceSource = 'manual' | 'inferred' | 'geocoded';

/**
 * A known place, projected entirely from existing graph shapes — NOT a bespoke
 * table. The assertion "this Location plays role X in my life" already has a
 * natural home: a relationship from the user's self entity to a `ci.entities`
 * Location node. So:
 *   - `id`          = the relationship_id (the canonical id of the assertion)
 *   - `locationId`  = the Location entity (ci.entities.entity_id)
 *   - `kind`        = LIVES_IN → home, WORKS_AT → work, VISITED → properties.kind
 *   - `confidence`  = relationship.strength
 *   - active range  = relationship.start_date / end_date (homes move → an era)
 *   - extras        = relationship.properties (coordinates, aliases, source, label)
 */
export interface KnownPlace {
  id: string;
  locationId: string;
  label: string;
  kind: KnownPlaceKind;
  coordinates: { lat: number; lng: number } | null;
  confidence: number;
  /** ISO date — inclusive lower bound of the era, or null. */
  activeFrom: string | null;
  /** ISO date, or null when still current. */
  activeTo: string | null;
  aliases: string[];
  source: KnownPlaceSource;
}

/** A candidate place discovered by the frequency / clustering pass. */
export interface KnownPlaceCandidate {
  /** ci.entities Location node id when the cluster is anchored to one. */
  locationId: string | null;
  /** Representative display name (location_name of the cluster's events). */
  label: string;
  /** Suggested kind from the clustering heuristic (home/work/other). */
  kind: KnownPlaceKind;
  /** Cluster centroid latitude. */
  lat: number;
  /** Cluster centroid longitude. */
  lng: number;
  /** Number of events supporting this cluster. */
  eventCount: number;
  /** Heuristic confidence in the candidate (0..1). */
  confidence: number;
}

/** Cluster the frequency pass accumulates before ranking. */
interface Cluster {
  locationId: string | null;
  labelCounts: Map<string, number>;
  latSum: number;
  lngSum: number;
  eventCount: number;
  /** Count of supporting events whose start hour is in 21:00–06:00 (home signal). */
  nightCount: number;
  /** Count of supporting events on weekdays in 09:00–17:00 (work signal). */
  workHoursCount: number;
}

/**
 * How many of the user's most-common places to surface as candidates. We rank
 * places by event frequency (the "top common places" the user actually spends
 * time at) and classify Home/Work among them — no clustering model, no separate
 * store.
 */
const MAX_CANDIDATES = 50;

/** Coordinate grid size (degrees) for snapping nearby events into one cluster (~1.1km). */
const CLUSTER_PRECISION = 2;

/** The graph relationship types that express a known place. */
const KNOWN_PLACE_RELATIONSHIP_TYPES = ['LIVES_IN', 'WORKS_AT', 'VISITED'] as const;
type KnownPlaceRelationship = (typeof KNOWN_PLACE_RELATIONSHIP_TYPES)[number];

/** Map a role to the graph relationship type that carries it. */
function relationshipForKind(kind: KnownPlaceKind): KnownPlaceRelationship {
  switch (kind) {
    case 'home':
      return 'LIVES_IN';
    case 'work':
      return 'WORKS_AT';
    default:
      // school / social / other all ride on VISITED; the nuance lives in
      // relationship.properties.kind so we don't invent new edge types.
      return 'VISITED';
  }
}

/** Recover the role from a relationship type (+ properties.kind for VISITED). */
function kindForRelationship(relationshipType: string, propsKind: unknown): KnownPlaceKind {
  if (relationshipType === 'LIVES_IN') {
    return 'home';
  }

  if (relationshipType === 'WORKS_AT') {
    return 'work';
  }

  return propsKind === 'school' || propsKind === 'social' || propsKind === 'other'
    ? (propsKind as KnownPlaceKind)
    : 'other';
}

/** Relationship.strength has a CHECK (0..1); clamp inferred confidences into range. */
function clampStrength(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

/** Row shape returned by the known-place relationship⋈entity queries. */
interface KnownPlaceRow {
  id: string;
  relationship_type: string;
  strength: number | null;
  start_date: string | null;
  end_date: string | null;
  properties: Record<string, unknown> | null;
  location_id: string;
  name: string | null;
}

/**
 * Known places: derives Home / Work and per-person common locations from the
 * event stream, and persists user-confirmed roles as graph relationships on the
 * EXISTING place shapes — there is no `known_place_labels` table. A confirmed
 * known place is just a `LIVES_IN` / `WORKS_AT` / `VISITED` relationship from the
 * user's self node to a `ci.entities` Location node, with `strength` as the
 * confidence, `start_date`/`end_date` as the era, and `properties` for the rest.
 *
 * Building is read-only and idempotent (pure aggregation over events with
 * coordinates). Confirmation (updateKnownPlace) upserts the relationship in
 * place on the existing partial-unique index, so re-confirming never duplicates.
 */
@Injectable()
export class KnownPlacesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(KnownPlacesService.name);
  }

  /**
   * Frequency + coarse coordinate-cluster pass over the user's geolocated
   * events. Returns the user's most-common places as Home/Work/other candidates,
   * ranked by support. Pure read — surfaces confirmable insights; persistence
   * happens in {@link updateKnownPlace}.
   */
  async buildKnownPlaces(context: UserServiceContext): Promise<KnownPlaceCandidate[]> {
    const rows: Array<{
      location_entity_id: string | null;
      location_name: string | null;
      lat: number;
      lng: number;
      start_time: Date;
    }> = await this.dataSource.query(
      `SELECT
         event.location_entity_id AS location_entity_id,
         event.location_name      AS location_name,
         ST_Y(event.location_coordinates::geometry) AS lat,
         ST_X(event.location_coordinates::geometry) AS lng,
         event.start_time         AS start_time
       FROM ci.events event
       WHERE event.user_id = $1
         AND event.location_coordinates IS NOT NULL`,
      [context.userId],
    );

    if (rows.length === 0) {
      return [];
    }

    const clusters = new Map<string, Cluster>();

    for (const row of rows) {
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        continue;
      }

      // Cluster key: the Location node when present, else a snapped coord grid
      // cell so nearby unlinked events still aggregate.
      const key =
        row.location_entity_id ?? `${lat.toFixed(CLUSTER_PRECISION)},${lng.toFixed(CLUSTER_PRECISION)}`;

      let cluster = clusters.get(key);
      if (!cluster) {
        cluster = {
          locationId: row.location_entity_id,
          labelCounts: new Map(),
          latSum: 0,
          lngSum: 0,
          eventCount: 0,
          nightCount: 0,
          workHoursCount: 0,
        };
        clusters.set(key, cluster);
      }

      cluster.latSum += lat;
      cluster.lngSum += lng;
      cluster.eventCount += 1;

      const name = row.location_name?.trim();
      if (name) {
        cluster.labelCounts.set(name, (cluster.labelCounts.get(name) ?? 0) + 1);
      }

      const date = new Date(row.start_time);
      const hour = date.getUTCHours();
      const day = date.getUTCDay(); // 0 = Sunday
      if (hour >= 21 || hour < 6) {
        cluster.nightCount += 1;
      }

      if (day >= 1 && day <= 5 && hour >= 9 && hour < 17) {
        cluster.workHoursCount += 1;
      }
    }

    const totalEvents = rows.length;

    const candidates: KnownPlaceCandidate[] = [...clusters.values()]
      .map((cluster) => this.clusterToCandidate(cluster, totalEvents))
      .sort((a, b) => b.eventCount - a.eventCount)
      .slice(0, MAX_CANDIDATES);

    // Mark the single strongest night-weighted cluster as the Home candidate and
    // the strongest work-hours cluster as Work, so the top two surface as the
    // confirmable Home/Work insights.
    this.assignPrimaryKinds(candidates, clusters);

    return candidates;
  }

  /**
   * The user's confirmed known places: active `LIVES_IN`/`WORKS_AT`/`VISITED`
   * relationships from their self node to Location entities. Optionally filtered
   * by role. Reads only existing shapes (ci.relationships ⋈ ci.entities).
   */
  async getKnownPlaces(context: UserServiceContext, kind?: KnownPlaceKind): Promise<KnownPlace[]> {
    const rows: KnownPlaceRow[] = await this.dataSource.query(
      `SELECT
         r.relationship_id   AS id,
         r.relationship_type AS relationship_type,
         r.strength          AS strength,
         r.start_date        AS start_date,
         r.end_date          AS end_date,
         r.properties        AS properties,
         e.entity_id         AS location_id,
         e.name              AS name
       FROM ci.relationships r
       JOIN ci.users u    ON u.entity_id = r.from_entity_id AND u.id = $1
       JOIN ci.entities e ON e.entity_id = r.to_entity_id AND e.entity_type = 'Location'
       WHERE r.is_active = TRUE
         AND r.relationship_type = ANY($2)
       ORDER BY r.strength DESC NULLS LAST, r.start_date DESC NULLS LAST`,
      [context.userId, KNOWN_PLACE_RELATIONSHIP_TYPES as unknown as string[]],
    );

    const places = rows.map((row) => this.rowToKnownPlace(row));

    return kind ? places.filter((place) => place.kind === kind) : places;
  }

  /**
   * Confirm / update a known place: upsert the role as a graph relationship from
   * the user's self node to an existing Location entity. No bespoke row — the
   * relationship IS the record. Idempotent on the existing partial-unique index
   * `(from_entity_id, to_entity_id, relationship_type) WHERE is_active = TRUE`.
   */
  async updateKnownPlace(
    context: UserServiceContext,
    input: {
      label: string;
      kind: KnownPlaceKind;
      locationId?: string | null;
      coordinates?: { lat: number; lng: number } | null;
      confidence?: number;
      activeFrom?: string;
      activeTo?: string | null;
      aliases?: string[];
      source?: KnownPlaceSource;
    },
  ): Promise<KnownPlace> {
    // A known place is an existing Location entity; confirming requires one.
    if (!input.locationId) {
      throw new Error('updateKnownPlace requires a locationId (the ci.entities Location to mark).');
    }

    const relationshipType = relationshipForKind(input.kind);
    const strength = clampStrength(input.confidence ?? 0.5);
    const coordinates =
      input.coordinates && Number.isFinite(input.coordinates.lat) && Number.isFinite(input.coordinates.lng)
        ? input.coordinates
        : null;

    // Everything the old table carried that isn't a first-class relationship
    // column rides in properties: the user's label, the role nuance (for
    // VISITED), provenance, aliases, and the confirmed coordinates ([lng,lat]).
    const properties: Record<string, unknown> = {
      kind: input.kind,
      label: input.label,
      source: input.source ?? 'manual',
      ...(input.aliases && input.aliases.length > 0 ? { aliases: input.aliases } : {}),
      ...(coordinates ? { coordinates: [coordinates.lng, coordinates.lat] } : {}),
    };

    const relationshipId = await this.upsertSelfRelationship(
      context.userId,
      input.locationId,
      relationshipType,
      {
        strength,
        startDate: input.activeFrom ?? null,
        endDate: input.activeTo ?? null,
        properties,
      },
    );

    const place = await this.getKnownPlaceById(context, relationshipId);
    if (!place) {
      throw new Error(`Known-place relationship ${relationshipId} vanished after upsert`);
    }

    return place;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private rowToKnownPlace(row: KnownPlaceRow): KnownPlace {
    const props = row.properties ?? {};
    const coordsRaw = props.coordinates;
    const coordinates =
      Array.isArray(coordsRaw) && coordsRaw.length === 2
        ? { lng: Number(coordsRaw[0]), lat: Number(coordsRaw[1]) }
        : null;
    const source =
      props.source === 'inferred' || props.source === 'geocoded'
        ? (props.source as KnownPlaceSource)
        : 'manual';

    return {
      id: row.id,
      locationId: row.location_id,
      label: row.name ?? (typeof props.label === 'string' ? props.label : 'Unknown place'),
      kind: kindForRelationship(row.relationship_type, props.kind),
      coordinates,
      confidence: Number(row.strength ?? 0),
      activeFrom: row.start_date === null ? null : String(row.start_date),
      activeTo: row.end_date === null ? null : String(row.end_date),
      aliases: Array.isArray(props.aliases) ? (props.aliases as string[]) : [],
      source,
    };
  }

  private async getKnownPlaceById(
    context: UserServiceContext,
    relationshipId: string,
  ): Promise<KnownPlace | null> {
    const rows: KnownPlaceRow[] = await this.dataSource.query(
      `SELECT
         r.relationship_id AS id, r.relationship_type AS relationship_type, r.strength AS strength,
         r.start_date AS start_date, r.end_date AS end_date, r.properties AS properties,
         e.entity_id AS location_id, e.name AS name
       FROM ci.relationships r
       JOIN ci.users u    ON u.entity_id = r.from_entity_id AND u.id = $1
       JOIN ci.entities e ON e.entity_id = r.to_entity_id AND e.entity_type = 'Location'
       WHERE r.relationship_id = $2`,
      [context.userId, relationshipId],
    );

    return rows[0] ? this.rowToKnownPlace(rows[0]) : null;
  }

  /**
   * Upsert a relationship from the user's self node to the Location node, keyed
   * on the existing partial-unique index. Returns the relationship_id.
   */
  private async upsertSelfRelationship(
    userId: string,
    locationId: string,
    relationshipType: KnownPlaceRelationship,
    opts: {
      strength: number;
      startDate: string | null;
      endDate: string | null;
      properties: Record<string, unknown>;
    },
  ): Promise<string> {
    const selfRows: Array<{ entity_id: string | null }> = await this.dataSource.query(
      `SELECT entity_id FROM ci.users WHERE id = $1`,
      [userId],
    );
    const selfEntityId = selfRows[0]?.entity_id;
    if (!selfEntityId) {
      throw new Error('Cannot write known-place relationship: user has no self entity');
    }

    // The dedup guard is the partial unique index
    //   relationships_unique_directed_idx (from_entity_id, to_entity_id,
    //   relationship_type) WHERE is_active = TRUE
    // so the ON CONFLICT target names those columns AND repeats the partial
    // predicate to bind to that index.
    const rows: Array<{ relationship_id: string }> = await this.dataSource.query(
      `INSERT INTO ci.relationships
         (relationship_id, from_entity_id, to_entity_id, relationship_type, strength,
          properties, is_active, start_date, end_date, owner_user_id,
          from_entity_type, to_entity_type)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, true, $7, $8, $9, 'User', 'Location')
       ON CONFLICT (from_entity_id, to_entity_id, relationship_type) WHERE is_active = TRUE
       DO UPDATE SET
         strength      = EXCLUDED.strength,
         properties    = EXCLUDED.properties,
         start_date    = EXCLUDED.start_date,
         end_date      = EXCLUDED.end_date,
         owner_user_id = EXCLUDED.owner_user_id,
         updated_at    = now()
       RETURNING relationship_id`,
      [
        uuidv7(),
        selfEntityId,
        locationId,
        relationshipType,
        opts.strength,
        JSON.stringify(opts.properties),
        opts.startDate,
        opts.endDate,
        userId,
      ],
    );

    return rows[0].relationship_id;
  }

  private clusterToCandidate(cluster: Cluster, totalEvents: number): KnownPlaceCandidate {
    const label = [...cluster.labelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown place';

    // Support fraction drives the base confidence; capped so an inferred
    // candidate never reaches the 1.0 ground-truth weight.
    const support = cluster.eventCount / Math.max(totalEvents, 1);
    const confidence = Math.min(0.4 + support, 0.9);

    return {
      locationId: cluster.locationId,
      label,
      kind: 'other',
      lat: cluster.latSum / cluster.eventCount,
      lng: cluster.lngSum / cluster.eventCount,
      eventCount: cluster.eventCount,
      confidence: Number(confidence.toFixed(3)),
    };
  }

  /**
   * Tag the most home-like and most work-like candidate among the top clusters.
   * Home = highest share of night-time events; Work = highest share of weekday
   * 9–5 events. The two are distinct clusters where possible.
   */
  private assignPrimaryKinds(candidates: KnownPlaceCandidate[], clusters: Map<string, Cluster>): void {
    const clusterFor = (candidate: KnownPlaceCandidate): Cluster | undefined =>
      [...clusters.values()].find(
        (cluster) =>
          (cluster.locationId && cluster.locationId === candidate.locationId) ||
          (Math.abs(cluster.latSum / cluster.eventCount - candidate.lat) < 1e-6 &&
            Math.abs(cluster.lngSum / cluster.eventCount - candidate.lng) < 1e-6),
      );

    let homeIdx = -1;
    let workIdx = -1;
    let bestNight = 0;
    let bestWork = 0;

    candidates.forEach((candidate, idx) => {
      const cluster = clusterFor(candidate);
      if (!cluster) {
        return;
      }

      const nightShare = cluster.nightCount / cluster.eventCount;
      const workShare = cluster.workHoursCount / cluster.eventCount;

      if (nightShare > bestNight) {
        bestNight = nightShare;
        homeIdx = idx;
      }

      if (workShare > bestWork) {
        bestWork = workShare;
        workIdx = idx;
      }
    });

    if (homeIdx >= 0 && bestNight > 0) {
      candidates[homeIdx].kind = 'home';
    }

    if (workIdx >= 0 && workIdx !== homeIdx && bestWork > 0) {
      candidates[workIdx].kind = 'work';
    }
  }
}
