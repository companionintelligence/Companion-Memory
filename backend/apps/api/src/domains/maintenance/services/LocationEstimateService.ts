import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

/**
 * Default physical-presence `source_system`s eligible for temporal location
 * estimation — events that represent the user BEING somewhere. Messages and
 * social posts are deliberately excluded: a post/email carries no inherent
 * "where I was", so estimating its location would pollute the map and the
 * home/work clustering (a 3am email must not snap to yesterday's restaurant).
 */
export const DEFAULT_ESTIMATE_SOURCE_SYSTEMS: readonly string[] = [
  'calendar',
  'apple_photos',
  'google_photos',
  'apple_health',
  'google_fit',
  'fitbit',
  'strava',
  'garmin',
  'withings',
  'uber',
  'lyft',
  'flighty',
  'amazon',
  'paypal',
  'venmo',
  'google_purchases',
  'google_maps_places',
  'google_location',
];

/** Default max gap (hours) between a candidate event and its donor location. */
export const DEFAULT_MAX_GAP_HOURS = 24;

/**
 * Estimated coordinates carry low confidence so HBPE / RAG / known-place
 * clustering discount them relative to measured or geocoded coordinates.
 */
export const ESTIMATED_CONFIDENCE = 0.4;

export interface EstimateBatchOptions {
  /** Max coordinate-less candidates to fill in this batch. */
  limit: number;
  /** Max time gap (hours) between a candidate and its donor location. */
  maxGapHours: number;
  /** `source_system`s eligible for estimation (physical-presence allowlist). */
  sourceSystems: string[];
  /**
   * Forced re-sweep: also consider rows that ALREADY carry an estimate
   * (metadata.location_source = 'estimated') as candidates, so when better donor
   * data lands later (e.g. a wave of GPS positions arrives) the existing estimates
   * get re-coordinated against the now-richer donor pool. Defaults to false —
   * standard incremental behaviour only touches coordinate-less rows.
   *
   * Predicate-relax (not destructive clear): a re-swept row whose donor lookup
   * returns nothing stays on its old estimate, so the map never regresses
   * mid-sweep. Only rows with a better donor in the gap get rewritten.
   */
  forced?: boolean;
}

export interface EstimateBatchResult {
  /** Coordinate-less candidates eligible for this batch (upper bound). */
  candidates: number;
  /** Candidates actually filled (those with a donor location within the gap). */
  estimated: number;
}

/**
 * LifeScope-style temporal location estimation. Fills `location_coordinates` for
 * physical-presence events that have no coordinates of their own by copying the
 * nearest-in-time REAL location — a `ci.position` GPS fix when available, else a
 * located event — within a bounded time gap. Mirrors LifeScope's "coordinates
 * set to the non-estimated location closest in time".
 *
 * Idempotent and re-runnable: estimated rows are excluded as both candidates and
 * donors (`metadata.location_source <> 'estimated'`), so re-runs never chain an
 * estimate off another estimate, and the `location_coordinates IS NULL` filter
 * guarantees measured/geocoded coordinates are never overwritten.
 */
@Injectable()
export class LocationEstimateService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(LocationEstimateService.name);
  }

  /**
   * The candidate filter, shared by {@link countCandidates} and the estimate
   * UPDATE so the count is EXACT (every counted row can actually be filled). A
   * candidate is a non-deleted, non-PREDICTED, physical-presence event without
   * usable own coordinates that has at least one real donor location within the
   * gap. `gapParam` and `forcedParam` are bind-placeholder names ($N) — static
   * strings this class controls, never user input. The donor predicates use a
   * sargable BETWEEN window (not abs(...)) so the planner can use the
   * (user_id, time) / (user_id, start_time) indexes.
   *
   * The `is_predicted = false` guard is REQUIRED: ci.events has a CHECK constraint
   * `valid_prediction_inference` (NOT (is_predicted AND is_inferred)); the estimate
   * is one set-based UPDATE that sets is_inferred=true, so a single predicted
   * candidate would violate the constraint and abort the ENTIRE batch. Predicted
   * future events should not be retro-located anyway.
   *
   * Requiring a donor here (not just in the per-row LATERAL) also fixes
   * starvation: ORDER BY start_time DESC LIMIT would otherwise fill its slots with
   * the newest candidates regardless of donor availability, so a run of donor-less
   * recent events could permanently shadow older fillable ones.
   *
   * When `forcedParam` evaluates true, previously-estimated rows are ALSO
   * candidates (the `location_coordinates IS NULL` filter is relaxed to admit
   * them, and the candidate-side `<> 'estimated'` exclusion is dropped). Donors
   * stay real either way — an estimate is never seeded from another estimate.
   */
  private candidatePredicate(gapParam: string, forcedParam: string): string {
    const window = `e.start_time - make_interval(secs => ${gapParam}) AND e.start_time + make_interval(secs => ${gapParam})`;

    return `e.user_id = $1
          AND (
            e.location_coordinates IS NULL
            OR (${forcedParam}::bool AND e.metadata->>'location_source' = 'estimated')
          )
          AND e.is_deleted = false
          AND COALESCE(e.is_predicted, false) = false
          AND e.source_system = ANY($2)
          AND (
            ${forcedParam}::bool
            OR COALESCE(e.metadata->>'location_source', '') <> 'estimated'
          )
          AND (
            EXISTS (
              SELECT 1 FROM ci.position p
               WHERE p.user_id = $1 AND p.location IS NOT NULL
                 AND p.time BETWEEN ${window}
            )
            OR EXISTS (
              SELECT 1 FROM ci.events n
               WHERE n.user_id = $1 AND n.location_coordinates IS NOT NULL
                 AND n.event_id <> e.event_id AND n.is_deleted = false
                 AND COALESCE(n.metadata->>'location_source', '') <> 'estimated'
                 AND n.start_time BETWEEN ${window}
            )
          )`;
  }

  /**
   * Coordinate-less physical-presence events that have a donor within the gap.
   * When `forced` is true, previously-estimated rows are also counted so a
   * re-sweep against newly-arrived donors can re-coordinate them.
   */
  async countCandidates(
    userId: string,
    sourceSystems: string[],
    maxGapSeconds: number,
    forced = false,
  ): Promise<number> {
    const rows: Array<{ count: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS count FROM ci.events e WHERE ${this.candidatePredicate('$3', '$4')}`,
      [userId, sourceSystems, maxGapSeconds, forced],
    );

    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Estimate up to `limit` candidates. Returns the eligible candidate count and
   * the number actually filled (a candidate with no donor location within the
   * gap is left untouched). A single set-based UPDATE — no per-row round-trips.
   */
  async estimateBatch(userId: string, opts: EstimateBatchOptions): Promise<EstimateBatchResult> {
    const maxGapSeconds = Math.round(opts.maxGapHours * 3600);
    const forced = opts.forced === true;
    const candidates = await this.countCandidates(userId, opts.sourceSystems, maxGapSeconds, forced);

    if (candidates === 0) {
      return { candidates: 0, estimated: 0 };
    }

    const updated: Array<{ event_id: string }> = await this.dataSource.query(
      `WITH candidate AS (
         SELECT e.event_id, e.start_time
           FROM ci.events e
          WHERE ${this.candidatePredicate('$4', '$7')}
          ORDER BY e.start_time DESC
          LIMIT $3
       )
       UPDATE ci.events tgt
          SET location_coordinates = d.coords,
              is_inferred = true,
              confidence_score = LEAST(COALESCE(tgt.confidence_score, 1.0), $5),
              metadata = COALESCE(tgt.metadata, '{}'::jsonb)
                         || jsonb_build_object('location_source', 'estimated'),
              inference_sources = jsonb_build_object(
                'method', 'temporal_nn',
                'donor', d.donor,
                'donor_id', d.donor_id,
                'delta_seconds', round(d.delta_seconds)::int,
                'accuracy_meters', d.accuracy_meters,
                'max_gap_hours', $6::numeric,
                'forced', $7::bool
              ),
              updated_at = now()
         FROM candidate c
         CROSS JOIN LATERAL (
           SELECT coords, donor, donor_id, delta_seconds, accuracy_meters
             FROM (
               -- Prefer a high-accuracy GPS breadcrumb (the true "non-estimated
               -- location closest in time"). Each UNION branch is parenthesized so
               -- its ORDER BY/LIMIT binds to that branch, not the whole union.
               (
                 SELECT p.location AS coords, 'position' AS donor, p.id::text AS donor_id,
                        abs(extract(epoch FROM (p.time - c.start_time))) AS delta_seconds,
                        p.accuracy_meters AS accuracy_meters
                   FROM ci.position p
                  WHERE p.user_id = $1
                    AND p.location IS NOT NULL
                    AND p.time BETWEEN c.start_time - make_interval(secs => $4)
                                   AND c.start_time + make_interval(secs => $4)
                  ORDER BY abs(extract(epoch FROM (p.time - c.start_time))) ASC
                  LIMIT 1
               )
               UNION ALL
               -- Fall back to the nearest located event with REAL (non-estimated)
               -- coordinates.
               (
                 SELECT n.location_coordinates AS coords, 'event' AS donor, n.event_id::text AS donor_id,
                        abs(extract(epoch FROM (n.start_time - c.start_time))) AS delta_seconds,
                        NULL::double precision AS accuracy_meters
                   FROM ci.events n
                  WHERE n.user_id = $1
                    AND n.location_coordinates IS NOT NULL
                    AND n.event_id <> c.event_id
                    AND n.is_deleted = false
                    AND COALESCE(n.metadata->>'location_source', '') <> 'estimated'
                    AND n.start_time BETWEEN c.start_time - make_interval(secs => $4)
                                         AND c.start_time + make_interval(secs => $4)
                  ORDER BY abs(extract(epoch FROM (n.start_time - c.start_time))) ASC
                  LIMIT 1
               )
             ) donors
            -- Nearest-in-time wins; a GPS position fix only breaks a tie at
            -- equal delta (it's the more precise source). Do NOT prefer a far
            -- position fix over a temporally-closer located event.
            ORDER BY delta_seconds ASC, (donor <> 'position')
            LIMIT 1
         ) d
        WHERE tgt.event_id = c.event_id
       RETURNING tgt.event_id`,
      [userId, opts.sourceSystems, opts.limit, maxGapSeconds, ESTIMATED_CONFIDENCE, opts.maxGapHours, forced],
    );

    const estimated = Array.isArray(updated) ? updated.length : 0;

    this.logger.log('Temporal location estimation batch complete', {
      userId,
      candidates,
      estimated,
      maxGapHours: opts.maxGapHours,
      forced,
    });

    return { candidates, estimated };
  }
}
