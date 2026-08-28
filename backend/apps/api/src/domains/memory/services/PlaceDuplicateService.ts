import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { pairKey } from '../entities/EntityMergeBlockEntity';
import { type Place, PlaceEntity } from '../entities/PlaceEntity';

import { EntityMergeBlockService } from './EntityMergeBlockService';

/** Why a group of places was proposed, strongest evidence first. */
export type PlaceDuplicateReason = 'place_id' | 'name_proximity';

export interface PlaceDuplicateGroup {
  reason: PlaceDuplicateReason;
  /** The shared provider place_id, or the shared name the cluster collapsed on. */
  value: string;
  places: Place[];
  /** Members in total, before truncation to MAX_GROUP_SIZE. */
  totalPlaces: number;
}

export interface PlaceDuplicatePage {
  groups: PlaceDuplicateGroup[];
  totalCount: number;
  hasMore: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_GROUP_SIZE = 6;

/**
 * Same figure `PlaceService.findOrCreateForGeocode` uses to REUSE a same-name
 * row at creation time. This finder is the retroactive half: rows created
 * before that check existed, or by paths that never went through it.
 *
 * DBSCAN's epsilon is in the geometry's units — degrees here — so the metre
 * radius is converted at the equator (1° ≈ 111.32 km). East–west that
 * overstates the distance by cos(latitude); at 45° the effective radius is
 * ~105 m rather than 150. Slightly too strict is the right side to err on for
 * a suggestion list, and it keeps the query a single window function.
 */
const NAME_PROXIMITY_METRES = 150;
const NAME_PROXIMITY_DEGREES = NAME_PROXIMITY_METRES / 111_320;

const REASON_RANK: Record<PlaceDuplicateReason, number> = {
  place_id: 0,
  name_proximity: 1,
};

/**
 * Finds groups of live Location entities that look like the same place.
 *
 * Two rungs:
 *  (a) the same provider `place_id` in `properties` — the strongest signal,
 *      and one creation-time dedupe already keys on, so a hit here means the
 *      rows predate it or came from another path;
 *  (b) the same name (trimmed, case-folded) within {@link NAME_PROXIMITY_METRES}
 *      — the snap-cell boundary case: one address, two pickups either side
 *      of a 0.001° edge.
 *
 * SUGGESTIONS ONLY. Merging is `PlaceMergeService.mergePlaces` and is a user
 * decision; a rejected group is remembered via `ci.entity_merge_blocks` so it
 * is never re-proposed.
 */
@Injectable()
export class PlaceDuplicateService {
  constructor(
    @InjectRepository(PlaceEntity)
    private readonly placeRepository: Repository<PlaceEntity>,
    private readonly mergeBlockService: EntityMergeBlockService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PlaceDuplicateService.name);
  }

  async findDuplicateGroups(
    context: UserServiceContext,
    options: { limit?: number; offset?: number } = {},
  ): Promise<PlaceDuplicatePage> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);

    const rows: Array<{
      kind: PlaceDuplicateReason;
      val: string;
      place_ids: string[];
      n: number | string;
      total: number | string;
    }> = await this.placeRepository.manager.query(
      `WITH live AS (
           SELECT entity_id, name, properties->>'place_id' AS place_id, location_point
             FROM ci.entities
            WHERE owner_user_id = $1
              AND entity_type = 'Location'
              AND merged_into_entity_id IS NULL
              AND is_active IS DISTINCT FROM FALSE
         ),
         keys AS (
           -- (a) Shared provider place_id.
           SELECT entity_id, 'place_id'::text AS kind, place_id AS val
             FROM live
            WHERE place_id IS NOT NULL AND btrim(place_id) <> ''
           UNION ALL
           -- (b) Same name, points within the radius. DBSCAN with minpoints 1
           -- labels every row; a label shared by 2+ rows is a cluster.
           SELECT entity_id, 'name_proximity', name_key || '#' || cluster_id::text
             FROM (
               SELECT entity_id,
                      lower(btrim(name)) AS name_key,
                      ST_ClusterDBSCAN(location_point::geometry, $4, 1)
                        OVER (PARTITION BY lower(btrim(name))) AS cluster_id
                 FROM live
                WHERE name IS NOT NULL AND btrim(name) <> '' AND location_point IS NOT NULL
             ) clustered
         ),
         grouped AS (
           SELECT kind, val,
                  (array_agg(entity_id ORDER BY entity_id))[1:$3] AS place_ids,
                  COUNT(*) AS n
             FROM keys
            GROUP BY kind, val
           HAVING COUNT(*) > 1
         )
         SELECT kind, val, place_ids, n, COUNT(*) OVER () AS total
           FROM grouped
          ORDER BY CASE kind WHEN 'place_id' THEN 0 ELSE 1 END, n DESC, val ASC
          LIMIT $2 OFFSET $5`,
      [context.userId, limit + 1, MAX_GROUP_SIZE, NAME_PROXIMITY_DEGREES, offset],
    );

    if (rows.length === 0) {
      return { groups: [], totalCount: 0, hasMore: false };
    }

    const totalCount = Number(rows[0].total ?? rows.length);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const allIds = [...new Set(page.flatMap((row) => row.place_ids))];
    const places = await this.loadPlaces(context, allIds);
    const byId = new Map(places.map((place) => [place.id, place]));
    const blocked = await this.mergeBlockService.blockedPairsAmong(context, allIds);

    const groups: PlaceDuplicateGroup[] = [];
    const seenMemberSets = new Set<string>();

    for (const row of page) {
      const candidates = dropBlocked(
        row.place_ids.map((id) => byId.get(id)).filter((place): place is Place => place != null),
        blocked,
      );

      if (candidates.length < 2) {
        continue;
      }

      const memberKey = candidates
        .map((place) => place.id)
        .sort()
        .join(',');

      if (seenMemberSets.has(memberKey)) {
        continue;
      }

      seenMemberSets.add(memberKey);

      groups.push({
        reason: row.kind,
        // The DBSCAN label is an implementation detail; show the shared name.
        value: row.kind === 'name_proximity' ? (candidates[0].name ?? row.val) : row.val,
        places: candidates,
        totalPlaces: Math.max(Number(row.n), candidates.length),
      });
    }

    groups.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason]);

    return { groups, totalCount, hasMore };
  }

  private async loadPlaces(context: UserServiceContext, ids: string[]): Promise<Place[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.placeRepository
      .createQueryBuilder('place')
      .where('place.owner_user_id = :userId', { userId: context.userId })
      .andWhere('place.entity_id IN (:...ids)', { ids })
      .getMany();

    return rows.map((row) => PlaceEntity.toEgressType(row));
  }
}

function dropBlocked(places: Place[], blocked: Set<string>): Place[] {
  if (blocked.size === 0) {
    return places;
  }

  const kept: Place[] = [];

  for (const place of places) {
    if (kept.every((other) => !blocked.has(pairKey(place.id, other.id)))) {
      kept.push(place);
    }
  }

  return kept;
}
