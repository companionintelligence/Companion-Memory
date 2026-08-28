import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import { PlaceUpdatedEvent } from '@ci/domains/memory/events';

import { type Place, PlaceEntity } from '../entities/PlaceEntity';

import { GraphDeltaWriter } from './GraphDeltaWriter';

/** Per-table re-point counts recorded in the `ci.entity_merges` audit row. */
export interface PlaceMergeCounts {
  /** `ci.events.location_entity_id` rows moved onto the target. */
  events: number;
  /** `ci.position` fixes whose location or reference place moved. */
  positions: number;
  /** Child places whose `parent_place_id` moved onto the target. */
  childPlaces: number;
  /** `ci.objects` rows (last-seen place, acquired-from) re-pointed. */
  objects: number;
  /** `ci.object_observations.place_entity_id` rows re-pointed. */
  observations: number;
  /** `ci.receipts` rows (place, merchant) re-pointed. */
  receipts: number;
  identifiers: number;
  relationshipsFrom: number;
  relationshipsTo: number;
  relationshipsDropped: number;
  searchRowsDeleted: number;
  tagLinksMoved: number;
}

/** The `ci.entity_merges.entity_type` value this service writes. */
const LOCATION_ENTITY_TYPE = 'Location';

/** The `ci.entities` columns a merge reads and folds. */
interface LocationRow {
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  merged_into_entity_id: string | null;
  parent_place_id: string | null;
  place_kind: string | null;
  has_point: boolean;
  has_boundary: boolean;
}

/**
 * Merges duplicate Location entities into one canonical row — the place
 * analogue of {@link PersonMergeService}, whose structure this follows so the
 * two read the same.
 *
 * The same address routinely lands as several rows: reverse-geocoding keys
 * only on a provider place_id (often absent) and a 0.001° snap cell, so two
 * pickups 80 m apart either side of a cell edge become two "61 Plantation"
 * rows. Nothing upstream can collapse them afterwards — a merge is the only
 * repair.
 *
 * A merge, in ONE transaction:
 *  1. `SELECT … FOR UPDATE` on the target and every source;
 *  2. validates every row exists, belongs to this user, is a LIVE Location,
 *     and that no source is an ancestor of the target (re-pointing children
 *     would otherwise create a parent cycle);
 *  3. re-points every column that can name a place: events, position fixes,
 *     child places, owned things (last-seen / acquired-from), sightings,
 *     receipts (place / merchant), identifier claims, and relationship
 *     endpoints (the known-places LIVES_IN / WORKS_AT / VISITED edges);
 *  4. folds the row — target wins every non-null scalar it already has; the
 *     point, boundary, parent and provider place_id fill from the first
 *     source that has one; properties merge target-wins;
 *  5. tombstones each source (`is_active = FALSE`, `merged_into_entity_id`)
 *     and compresses any tombstone that already pointed at one, so the chain
 *     stays a single hop;
 *  6. deletes the sources' search rows and moves their tag links;
 *  7. writes one `ci.entity_merges` audit row per source.
 *
 * After commit a `PlaceUpdatedEvent` re-indexes the target.
 */
@Injectable()
export class PlaceMergeService {
  constructor(
    @InjectRepository(PlaceEntity)
    private readonly placeRepository: Repository<PlaceEntity>,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
    private readonly graphDeltaWriter: GraphDeltaWriter,
  ) {
    this.logger.setContext(PlaceMergeService.name);
  }

  async mergePlaces(
    context: UserServiceContext,
    sourceIds: string[],
    targetId: string,
  ): Promise<{ target: Place; counts: PlaceMergeCounts }> {
    const ownerUserId = context.userId;
    const sources = [...new Set(sourceIds)].filter((id) => id !== targetId);
    if (sources.length === 0) {
      throw new BadRequestException('mergePlaces needs at least one source distinct from the target');
    }

    const manager = this.placeRepository.manager;

    const counts = await manager.transaction(async (em) => {
      const rows: LocationRow[] = await em.query(
        `SELECT entity_id, entity_type, name, description, properties, merged_into_entity_id,
                parent_place_id, place_kind,
                location_point IS NOT NULL AS has_point,
                location_boundary IS NOT NULL AS has_boundary
           FROM ci.entities
          WHERE owner_user_id = $1 AND entity_id = ANY($2::uuid[])
          FOR UPDATE`,
        [ownerUserId, [targetId, ...sources]],
      );

      const byId = new Map(rows.map((row) => [row.entity_id, row]));
      const target = byId.get(targetId);
      if (!target) {
        throw new NotFoundException(`Merge target ${targetId} not found`);
      }

      if (target.entity_type !== LOCATION_ENTITY_TYPE || target.merged_into_entity_id != null) {
        throw new BadRequestException('Merge target must be a live Location entity');
      }

      for (const id of sources) {
        const source = byId.get(id);
        if (!source) {
          throw new NotFoundException(`Merge source ${id} not found`);
        }

        if (source.entity_type !== LOCATION_ENTITY_TYPE || source.merged_into_entity_id != null) {
          throw new BadRequestException(`Merge source ${id} must be a live Location entity`);
        }
      }

      // A source that is an ANCESTOR of the target (the city a street sits in)
      // cannot be folded into it: its children would be re-pointed at the
      // target, and the target's own parent chain would then loop back on
      // itself. Walk up from the target and refuse if a source is on the path.
      const ancestors: Array<{ entity_id: string }> = await em.query(
        `WITH RECURSIVE up AS (
           SELECT parent_place_id AS entity_id, 1 AS depth
             FROM ci.entities WHERE entity_id = $2 AND owner_user_id = $1
           UNION ALL
           SELECT e.parent_place_id, up.depth + 1
             FROM ci.entities e JOIN up ON e.entity_id = up.entity_id
            WHERE e.parent_place_id IS NOT NULL AND up.depth < 32
         )
         SELECT entity_id FROM up WHERE entity_id = ANY($3::uuid[])`,
        [ownerUserId, targetId, sources],
      );
      if (ancestors.length > 0) {
        throw new BadRequestException(
          'A place cannot be merged into one of the places it contains — merge the other way round',
        );
      }

      const counts = await this.repointReferences(em, ownerUserId, sources, targetId);

      // Fold: target wins every scalar it already has. The point/boundary/
      // parent/place_id fill from the first source that carries one, which
      // is what lets a bare grid-cluster row inherit the geocoded twin's
      // provider identity and footprint.
      const sourceRows = sources.map((id) => byId.get(id)!);
      const mergedName = firstNonEmpty([target.name, ...sourceRows.map((row) => row.name)]);
      const mergedDescription = firstNonEmpty([
        target.description,
        ...sourceRows.map((row) => row.description),
      ]);
      const mergedProperties = foldProperties(
        target.properties ?? {},
        sourceRows.map((row) => row.properties ?? {}),
      );
      const pointDonor = target.has_point
        ? null
        : (sourceRows.find((row) => row.has_point)?.entity_id ?? null);
      const boundaryDonor = target.has_boundary
        ? null
        : (sourceRows.find((row) => row.has_boundary)?.entity_id ?? null);
      const parentDonor =
        target.parent_place_id ??
        sourceRows.map((row) => row.parent_place_id).find((id) => id != null && id !== targetId) ??
        null;
      const mergedKind = target.place_kind ?? sourceRows.find((row) => row.place_kind)?.place_kind ?? null;

      await em.query(
        `UPDATE ci.entities t
            SET name = $3,
                description = $4,
                properties = $5::jsonb,
                place_kind = $6,
                parent_place_id = $7,
                location_point = COALESCE(t.location_point,
                  (SELECT d.location_point FROM ci.entities d WHERE d.entity_id = $8::uuid)),
                location_boundary = COALESCE(t.location_boundary,
                  (SELECT d.location_boundary FROM ci.entities d WHERE d.entity_id = $9::uuid)),
                updated_at = now()
          WHERE t.owner_user_id = $1 AND t.entity_id = $2`,
        [
          ownerUserId,
          targetId,
          mergedName,
          mergedDescription,
          JSON.stringify(mergedProperties),
          mergedKind,
          parentDonor,
          pointDonor,
          boundaryDonor,
        ],
      );

      await em.query(
        `UPDATE ci.entities
            SET merged_into_entity_id = $3, is_active = FALSE, parent_place_id = NULL, updated_at = now()
          WHERE owner_user_id = $1 AND entity_id = ANY($2::uuid[])`,
        [ownerUserId, sources, targetId],
      );

      await this.graphDeltaWriter.recordMany(
        [
          {
            nodeType: 'entity' as const,
            changeType: 'updated' as const,
            entityId: targetId,
            entityType: LOCATION_ENTITY_TYPE,
            ownerUserId,
            changeSource: 'PlaceMergeService.mergePlaces',
            changedByUserId: ownerUserId,
            changedFields: {
              name: { new: mergedName },
              description: { new: mergedDescription },
              properties: { new: mergedProperties },
            },
          },
          ...sources.map((sourceId) => ({
            nodeType: 'entity' as const,
            changeType: 'merged' as const,
            entityId: sourceId,
            entityType: LOCATION_ENTITY_TYPE,
            ownerUserId,
            changeSource: 'PlaceMergeService.mergePlaces',
            changedByUserId: ownerUserId,
            changedFields: {
              name: { old: byId.get(sourceId)?.name ?? null },
              merged_into_entity_id: { new: targetId },
            },
          })),
        ],
        em,
      );

      // Path compression: keep `merged_into_entity_id` one hop deep (every
      // resolver follows exactly one hop — see PersonMergeService).
      await em.query(
        `UPDATE ci.entities
            SET merged_into_entity_id = $3, updated_at = now()
          WHERE owner_user_id = $1 AND merged_into_entity_id = ANY($2::uuid[])`,
        [ownerUserId, sources, targetId],
      );

      // Tombstones must stop matching in search — both stores.
      const embeddings: unknown[] = await em.query(
        `DELETE FROM ci_search.embeddings
          WHERE user_id = $1 AND entity_id = ANY($2::uuid[])
          RETURNING 1`,
        [ownerUserId, sources],
      );
      const vectors: unknown[] = await em.query(
        `DELETE FROM ci_search.vectors
          WHERE user_id = $1 AND entity_id = ANY($2::uuid[])
          RETURNING 1`,
        [ownerUserId, sources],
      );
      counts.searchRowsDeleted = embeddings.length + vectors.length;

      // Tags: move each source's links to the target, skipping ones the target
      // already has and collapsing duplicate claims across sources to one row.
      const tagLinksMoved: unknown[] = await em.query(
        `UPDATE ci_search.entity_tag t
            SET entity_id = $2
          WHERE t.entity_type = 'place' AND t.entity_id = ANY($1::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM ci_search.entity_tag d
               WHERE d.entity_type = 'place' AND d.entity_id = $2 AND d.tag_id = t.tag_id)
            AND t.id IN (
              SELECT DISTINCT ON (tag_id) id
                FROM ci_search.entity_tag
               WHERE entity_type = 'place' AND entity_id = ANY($1::uuid[])
               ORDER BY tag_id, id ASC)
          RETURNING 1`,
        [sources, targetId],
      );
      counts.tagLinksMoved = tagLinksMoved.length;

      await em.query(
        `DELETE FROM ci_search.entity_tag
          WHERE entity_type = 'place' AND entity_id = ANY($1::uuid[])`,
        [sources],
      );

      for (const id of sources) {
        await em.query(
          `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            ownerUserId,
            id,
            targetId,
            LOCATION_ENTITY_TYPE,
            JSON.stringify({
              counts,
              sourceName: byId.get(id)?.name ?? null,
              sourceProperties: byId.get(id)?.properties ?? {},
            }),
          ],
        );
      }

      this.logger.log(`Merged ${sources.length} place(s) into ${targetId}: ${JSON.stringify(counts)}`);

      return counts;
    });

    await this.eventService.send(PlaceUpdatedEvent, { placeId: targetId });

    const entity = await this.placeRepository.findOne({
      where: { id: targetId, user: { id: ownerUserId } },
      relations: ['user'],
    });

    if (!entity) {
      throw new NotFoundException(`Merge target ${targetId} vanished mid-merge`);
    }

    return { target: PlaceEntity.toEgressType(entity), counts };
  }

  /**
   * Re-point every dependent reference from the sources to the target. All
   * statements are owner-scoped.
   */
  private async repointReferences(
    em: EntityManager,
    ownerUserId: string,
    sources: string[],
    targetId: string,
  ): Promise<PlaceMergeCounts> {
    // ci.position is a compressed hypertable; lift the per-txn decompression
    // cap the way PersonMergeService does for communications.
    await em.query('SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0');

    const events: unknown[] = await em.query(
      `UPDATE ci.events SET location_entity_id = $3
        WHERE user_id = $1 AND location_entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const positionLocation: unknown[] = await em.query(
      `UPDATE ci.position SET location_entity_id = $3
        WHERE user_id = $1 AND location_entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const positionReference: unknown[] = await em.query(
      `UPDATE ci.position SET reference_entity_id = $3
        WHERE user_id = $1 AND reference_entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    // Children of a source become children of the target. The target itself
    // is excluded: if it was (wrongly) parented under a source, the fold step
    // re-parents it from the source's own parent instead.
    const childPlaces: unknown[] = await em.query(
      `UPDATE ci.entities SET parent_place_id = $3, updated_at = now()
        WHERE owner_user_id = $1 AND parent_place_id = ANY($2::uuid[]) AND entity_id <> $3
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const objectsLastSeen: unknown[] = await em.query(
      `UPDATE ci.objects SET last_seen_place_entity_id = $3
        WHERE user_id = $1 AND last_seen_place_entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const objectsAcquiredFrom: unknown[] = await em.query(
      `UPDATE ci.objects SET acquired_from_entity_id = $3
        WHERE user_id = $1 AND acquired_from_entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const observations: unknown[] = await em.query(
      `UPDATE ci.object_observations SET place_entity_id = $3
        WHERE user_id = $1 AND place_entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const receiptsPlace: unknown[] = await em.query(
      `UPDATE ci.receipts SET place_entity_id = $3
        WHERE user_id = $1 AND place_entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const receiptsMerchant: unknown[] = await em.query(
      `UPDATE ci.receipts SET merchant_entity_id = $3
        WHERE user_id = $1 AND merchant_entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const identifiers: unknown[] = await em.query(
      `UPDATE ci.entity_identifiers SET entity_id = $3
        WHERE owner_user_id = $1 AND entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    // Relationships (LIVES_IN / WORKS_AT / VISITED and any other edge): drop
    // edges that would become self-references or only joined the duplicates,
    // then guarded re-points that respect relationships_unique_directed_idx —
    // the same two-guard statement PersonMergeService uses.
    const droppedSelfRef: unknown[] = await em.query(
      `DELETE FROM ci.relationships
        WHERE owner_user_id = $1
          AND ( (from_entity_id = ANY($2::uuid[]) AND (to_entity_id = $3 OR to_entity_id = ANY($2::uuid[])))
             OR (to_entity_id = ANY($2::uuid[]) AND from_entity_id = $3) )
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const relationshipsFrom: unknown[] = await em.query(
      `UPDATE ci.relationships r SET from_entity_id = $3
        WHERE r.owner_user_id = $1 AND r.from_entity_id = ANY($2::uuid[])
          AND (
            r.is_active IS DISTINCT FROM TRUE
            OR (
              NOT EXISTS (
                SELECT 1 FROM ci.relationships d
                 WHERE d.from_entity_id = $3 AND d.to_entity_id = r.to_entity_id
                   AND d.relationship_type = r.relationship_type AND d.is_active = TRUE)
              AND r.relationship_id IN (
                SELECT DISTINCT ON (to_entity_id, relationship_type) relationship_id
                  FROM ci.relationships
                 WHERE owner_user_id = $1 AND from_entity_id = ANY($2::uuid[]) AND is_active = TRUE
                 ORDER BY to_entity_id, relationship_type, created_at ASC)
            )
          )
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const droppedFromDupes: unknown[] = await em.query(
      `DELETE FROM ci.relationships
        WHERE owner_user_id = $1 AND from_entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources],
    );

    const relationshipsTo: unknown[] = await em.query(
      `UPDATE ci.relationships r SET to_entity_id = $3
        WHERE r.owner_user_id = $1 AND r.to_entity_id = ANY($2::uuid[])
          AND (
            r.is_active IS DISTINCT FROM TRUE
            OR (
              NOT EXISTS (
                SELECT 1 FROM ci.relationships d
                 WHERE d.from_entity_id = r.from_entity_id AND d.to_entity_id = $3
                   AND d.relationship_type = r.relationship_type AND d.is_active = TRUE)
              AND r.relationship_id IN (
                SELECT DISTINCT ON (from_entity_id, relationship_type) relationship_id
                  FROM ci.relationships
                 WHERE owner_user_id = $1 AND to_entity_id = ANY($2::uuid[]) AND is_active = TRUE
                 ORDER BY from_entity_id, relationship_type, created_at ASC)
            )
          )
        RETURNING 1`,
      [ownerUserId, sources, targetId],
    );

    const droppedToDupes: unknown[] = await em.query(
      `DELETE FROM ci.relationships
        WHERE owner_user_id = $1 AND to_entity_id = ANY($2::uuid[])
        RETURNING 1`,
      [ownerUserId, sources],
    );

    return {
      events: events.length,
      positions: positionLocation.length + positionReference.length,
      childPlaces: childPlaces.length,
      objects: objectsLastSeen.length + objectsAcquiredFrom.length,
      observations: observations.length,
      receipts: receiptsPlace.length + receiptsMerchant.length,
      identifiers: identifiers.length,
      relationshipsFrom: relationshipsFrom.length,
      relationshipsTo: relationshipsTo.length,
      relationshipsDropped: droppedSelfRef.length + droppedFromDupes.length + droppedToDupes.length,
      searchRowsDeleted: 0,
      tagLinksMoved: 0,
    };
  }
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }

  return null;
}

/**
 * Target wins every key it already has a non-null value for; anything else
 * fills from the sources in order. `promote` / `source` bookkeeping rides
 * along like any other key — the target's own provenance is kept.
 */
function foldProperties(
  target: Record<string, unknown>,
  sources: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target };

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value == null) {
        continue;
      }

      if (merged[key] == null) {
        merged[key] = value;
      }
    }
  }

  return merged;
}
