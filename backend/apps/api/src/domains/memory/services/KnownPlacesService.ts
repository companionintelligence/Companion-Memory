import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import {
  KnownPlaceLabelEntity,
  type KnownPlaceKind,
  type KnownPlaceLabel,
  type KnownPlaceSource,
} from '../entities/KnownPlaceLabelEntity';

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
  /** Fraction of supporting events whose start hour is in 21:00–06:00 (home signal). */
  nightCount: number;
  /** Fraction of supporting events on weekdays in 09:00–17:00 (work signal). */
  workHoursCount: number;
}

const MAX_CANDIDATES = 10;

/** Coordinate grid size (degrees) for snapping nearby events into one cluster (~1.1km). */
const CLUSTER_PRECISION = 2;

/**
 * Known places: derives Home / Work / "places lived" and per-person common
 * locations from the event stream, and persists user-confirmed labels with the
 * corresponding graph relationships (geodata-plan Phase 3).
 *
 * Building is read-only and idempotent (pure aggregation over events with
 * coordinates). Confirmation (updateKnownPlace) writes a LIVES_IN / WORKS_AT
 * edge from the user's self node to the Location node plus a label row, both
 * upserted in place so re-confirming does not duplicate.
 */
@Injectable()
export class KnownPlacesService {
  constructor(
    @InjectRepository(KnownPlaceLabelEntity)
    private readonly labelRepository: Repository<KnownPlaceLabelEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(KnownPlacesService.name);
  }

  /**
   * Frequency + coarse coordinate-cluster pass over the user's geolocated
   * events. Returns the top clusters as Home/Work/other candidates, ranked by
   * support. Pure read — surfaces confirmable insights; persistence happens in
   * {@link updateKnownPlace}.
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

  /** Read persisted known-place labels, optionally filtered by kind. */
  async getKnownPlaces(context: UserServiceContext, kind?: KnownPlaceKind): Promise<KnownPlaceLabel[]> {
    const rows = await this.labelRepository.find({
      where: {
        userId: context.userId,
        ...(kind ? { kind } : {}),
      },
      order: { confidence: 'DESC', activeFrom: 'DESC' },
    });

    return rows.map((row) => KnownPlaceLabelEntity.toEgressType(row));
  }

  /**
   * User-confirm a known place: upsert the label row and write the matching
   * LIVES_IN (home) / WORKS_AT (work) relationship from the user's self node to
   * the Location node. Idempotent on (user_id, label, active_from) for the row
   * and on (from, to, type) for the relationship.
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
  ): Promise<KnownPlaceLabel> {
    const activeFrom = input.activeFrom ?? '1970-01-01';
    const coordinates =
      input.coordinates && Number.isFinite(input.coordinates.lat) && Number.isFinite(input.coordinates.lng)
        ? { type: 'Point' as const, coordinates: [input.coordinates.lng, input.coordinates.lat] }
        : null;

    // Upsert the label row keyed on the unique (user_id, label, active_from).
    const existing = await this.labelRepository.findOne({
      where: { userId: context.userId, label: input.label, activeFrom },
    });

    const id = existing?.id ?? uuidv7();

    await this.dataSource.query(
      `INSERT INTO ci.known_place_labels
         (id, user_id, location_id, label, kind, coordinates, confidence, active_from, active_to, aliases, source)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $6::jsonb IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_MakePoint(($6::jsonb->>'lng')::float8, ($6::jsonb->>'lat')::float8), 4326)::geography
               END,
               $7, $8, $9, $10, $11)
       ON CONFLICT (user_id, label, active_from) DO UPDATE SET
         location_id = EXCLUDED.location_id,
         kind        = EXCLUDED.kind,
         coordinates = EXCLUDED.coordinates,
         confidence  = EXCLUDED.confidence,
         active_to   = EXCLUDED.active_to,
         aliases     = EXCLUDED.aliases,
         source      = EXCLUDED.source,
         updated_at  = now()`,
      [
        id,
        context.userId,
        input.locationId ?? null,
        input.label,
        input.kind,
        coordinates ? JSON.stringify({ lat: input.coordinates!.lat, lng: input.coordinates!.lng }) : null,
        input.confidence ?? 0.5,
        activeFrom,
        input.activeTo ?? null,
        input.aliases ?? [],
        input.source ?? 'manual',
      ],
    );

    // Write the corresponding graph edge for home/work so graph expansion
    // ("where do you live", "where do you work") can answer relationally.
    const relationshipType = this.kindToRelationship(input.kind);
    if (relationshipType && input.locationId) {
      await this.writeSelfRelationship(context.userId, input.locationId, relationshipType, {
        activeFrom,
        activeTo: input.activeTo ?? null,
        confidence: input.confidence ?? 0.5,
      });
    }

    const row = await this.labelRepository.findOne({ where: { id } });
    if (!row) {
      throw new Error(`Known-place label ${id} vanished after upsert`);
    }

    return KnownPlaceLabelEntity.toEgressType(row);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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

  private kindToRelationship(kind: KnownPlaceKind): 'LIVES_IN' | 'WORKS_AT' | null {
    switch (kind) {
      case 'home':
        return 'LIVES_IN';
      case 'work':
        return 'WORKS_AT';
      default:
        return null;
    }
  }

  /**
   * Upsert a relationship from the user's self node to the location node. Keyed
   * on (from, to, type) so re-confirming refreshes dates/strength in place.
   */
  private async writeSelfRelationship(
    userId: string,
    locationId: string,
    relationshipType: 'LIVES_IN' | 'WORKS_AT',
    opts: { activeFrom: string; activeTo: string | null; confidence: number },
  ): Promise<void> {
    const selfRows: Array<{ entity_id: string | null }> = await this.dataSource.query(
      `SELECT entity_id FROM ci.users WHERE id = $1`,
      [userId],
    );
    const selfEntityId = selfRows[0]?.entity_id;
    if (!selfEntityId) {
      this.logger.warn('Cannot write known-place relationship: user has no self entity', { userId });

      return;
    }

    // The dedup guard is the partial unique index
    //   relationships_unique_directed_idx (from_entity_id, to_entity_id,
    //   relationship_type) WHERE is_active = TRUE
    // so the ON CONFLICT target must name those columns AND repeat the partial
    // predicate to bind to that index.
    await this.dataSource.query(
      `INSERT INTO ci.relationships
         (relationship_id, from_entity_id, to_entity_id, relationship_type, strength,
          is_active, start_date, end_date, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)
       ON CONFLICT (from_entity_id, to_entity_id, relationship_type) WHERE is_active = TRUE
       DO UPDATE SET
         strength      = EXCLUDED.strength,
         start_date    = EXCLUDED.start_date,
         end_date      = EXCLUDED.end_date,
         owner_user_id = EXCLUDED.owner_user_id,
         updated_at    = now()`,
      [
        uuidv7(),
        selfEntityId,
        locationId,
        relationshipType,
        opts.confidence,
        opts.activeFrom,
        opts.activeTo,
        userId,
      ],
    );
  }
}
