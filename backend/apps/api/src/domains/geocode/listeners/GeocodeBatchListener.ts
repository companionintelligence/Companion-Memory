import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import plimit from 'p-limit';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { OnEvent } from '@ci/domains/events';
import { EventEntity, EventService } from '@ci/domains/memory';
import { GeocodeBatchRequestEvent, type GeocodeBatchRequestPayload } from '@ci/domains/memory/events';

import {
  GeocodeService,
  RETRYABLE_STATUSES,
  VIRTUAL_STATUS,
  type ReverseGeocodeOutcome,
} from '../services/GeocodeService';

/** Dedicated PGBoss queue so geocode backfills don't block the default queue. */
const GEOCODE_QUEUE = 'geocode';

/**
 * Hard concurrency ceiling on in-flight provider calls, independent of the QPS
 * throttle. Well under Google's 25 QPS, it bounds memory / open sockets even if
 * rateLimitPerSecond were misconfigured high. The effective rate is the lower
 * of this cap and config.geocoding.rateLimitPerSecond.
 */
const MAX_CONCURRENCY = 10;

/** Exponential-backoff schedule (ms) for transient provider failures. */
const BACKOFF_MS = [500, 1500, 4000];

/**
 * Token-bucket / minimum-interval QPS throttle. Concurrency (p-limit) caps how
 * many calls run *at once*; this caps how many *start per second*. A burst of
 * cache misses otherwise fires MAX_CONCURRENCY calls instantly and can trip
 * OVER_QUERY_LIMIT regardless of the concurrency cap, so the two are
 * complementary. `acquire()` resolves no sooner than `1000 / qps` ms after the
 * previous acquisition.
 */
export class RateLimiter {
  private readonly minIntervalMs: number;

  private nextAvailableAt = 0;

  constructor(qps: number) {
    // Guard against a 0/negative config slipping through (schema enforces
    // positive, but be defensive): fall back to unthrottled.
    this.minIntervalMs = qps > 0 ? 1000 / qps : 0;
  }

  async acquire(): Promise<void> {
    if (this.minIntervalMs <= 0) {
      return;
    }

    const now = Date.now();
    const startAt = Math.max(now, this.nextAvailableAt);
    this.nextAvailableAt = startAt + this.minIntervalMs;

    const waitMs = startAt - now;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

interface CandidateRow {
  event_id: string;
  location_name: string;
}

interface ReverseCandidateRow {
  event_id: string;
  /** Latitude/longitude read out of the geography Point via ST_Y/ST_X. */
  lat: number;
  lng: number;
}

/**
 * Consumes {@link GeocodeBatchRequestEvent}: selects events carrying a
 * location_name but no location_coordinates (the backfill set), forward-geocodes
 * each via {@link GeocodeService}, and writes location_coordinates +
 * confidence_score back through {@link EventService.update}.
 *
 * Idempotent: the candidate query excludes already-geocoded events, and a
 * re-run updates in place (EventService.update is keyed on event_id), so it can
 * be enqueued repeatedly without duplicating work.
 */
@Injectable()
export class GeocodeBatchListener {
  /** Concurrency cap: min(MAX_CONCURRENCY, configured QPS) — never exceed either. */
  private readonly limiter = plimit(Math.min(MAX_CONCURRENCY, config.geocoding.rateLimitPerSecond));

  /** QPS throttle from config.geocoding.rateLimitPerSecond (default 10). */
  private readonly rateLimiter = new RateLimiter(config.geocoding.rateLimitPerSecond);

  /** Default batch size from config.geocoding.batchSize (default 200). */
  private readonly defaultLimit = config.geocoding.batchSize;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly geocodeService: GeocodeService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GeocodeBatchListener.name);
  }

  @OnEvent(GeocodeBatchRequestEvent, { queue: GEOCODE_QUEUE })
  async handleBatch(payload: GeocodeBatchRequestPayload): Promise<void> {
    const { userId, eventIds, limit, retryNull, direction } = payload;
    const retry = retryNull ?? false;
    const batchLimit = limit ?? this.defaultLimit;

    // Reverse direction (coords -> name) shares this queue + rate limiter so the
    // two never collectively exceed the provider's QPS.
    if (direction === 'reverse') {
      await this.handleReverseBatch(userId, { eventIds, limit: batchLimit, retryNull: retry });

      return;
    }

    const context: UserServiceContext = { userId };

    const candidates = await this.selectCandidates(userId, {
      eventIds,
      limit: batchLimit,
      retryNull: retry,
    });

    this.logger.log('Starting geocode backfill batch', {
      userId,
      candidateCount: candidates.length,
    });

    let resolved = 0;
    let virtual = 0;
    let failed = 0;
    let skipped = 0;

    await Promise.all(
      candidates.map((candidate) =>
        this.limiter(async () => {
          const outcome = await this.geocodeWithRetry(candidate.location_name, retry);

          if (outcome.status === 'OK' && outcome.point && outcome.confidence !== null) {
            await this.eventService.update(context, candidate.event_id, {
              location_coordinates: outcome.point,
              // Inferred / coarse coords carry < 1.0 so HBPE/RAG don't treat
              // them as ground truth.
              confidence_score: outcome.confidence,
            });
            // A coarse APPROXIMATE centroid (<= 0.4) — likely a non-address
            // label that slipped past the denylist resolving to a city center.
            // Tag it so it is distinguishable from a precise street/venue hit.
            if (outcome.lowConfidence) {
              await this.tagLocationSource(context, candidate.event_id, 'approximate');
            }

            resolved++;

            return;
          }

          if (outcome.status === VIRTUAL_STATUS) {
            // Non-physical venue: record provenance so it's not retried, but
            // never write coordinates.
            await this.tagLocationSource(context, candidate.event_id, 'virtual');
            virtual++;

            return;
          }

          if (outcome.retryable) {
            // Exhausted retries on a transient failure — leave for the next run.
            failed++;

            return;
          }

          // Non-retryable negative result (ZERO_RESULTS / REQUEST_DENIED /
          // INVALID_REQUEST). Cached in geocode_cache so the next run skips the
          // provider call entirely.
          skipped++;
        }),
      ),
    );

    this.logger.log('Completed geocode backfill batch', {
      userId,
      resolved,
      virtual,
      skipped,
      failed,
      candidateCount: candidates.length,
    });
  }

  /**
   * Geocode with exponential backoff on transient provider failures. Non-
   * retryable statuses (and successes) return immediately. Each provider-facing
   * attempt waits on the QPS throttle first (cache hits inside GeocodeService
   * still short-circuit before any network call). `bustCache` re-attempts a
   * previously negative-cached location (the retryNull path).
   */
  private async geocodeWithRetry(location: string, bustCache: boolean) {
    await this.rateLimiter.acquire();
    let outcome = await this.geocodeService.geocode(location, { bustCache });

    for (let attempt = 0; outcome.retryable && attempt < BACKOFF_MS.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
      await this.rateLimiter.acquire();
      // A retry is always a fresh provider call; bust the cache so a transient
      // status that briefly got cached can't pin the result.
      outcome = await this.geocodeService.geocode(location, { bustCache: true });
    }

    if (outcome.retryable && RETRYABLE_STATUSES.has(outcome.status)) {
      this.logger.warn('Geocode exhausted retries for location', {
        location,
        status: outcome.status,
      });
    }

    return outcome;
  }

  /**
   * Reverse-geocode backfill: events that have coordinates (photo EXIF / GPS /
   * estimation) but no readable location_name get one, so a bare map pin gains a
   * label. Idempotent — a resolved row now HAS a name and drops out of the
   * candidate set; re-runs serve negative results from the geocode cache.
   */
  private async handleReverseBatch(
    userId: string,
    opts: { eventIds?: string[]; limit: number; retryNull: boolean },
  ): Promise<void> {
    const context: UserServiceContext = { userId };
    const candidates = await this.selectReverseCandidates(userId, opts);

    this.logger.log('Starting reverse-geocode backfill batch', {
      userId,
      candidateCount: candidates.length,
    });

    let resolved = 0;
    let failed = 0;
    let skipped = 0;

    await Promise.all(
      candidates.map((candidate) =>
        this.limiter(async () => {
          // ST_Y/ST_X come back as doubles; coerce defensively in case the
          // driver hands them over as numeric strings.
          const outcome = await this.reverseGeocodeWithRetry(
            Number(candidate.lat),
            Number(candidate.lng),
            opts.retryNull,
          );

          if (outcome.status === 'OK' && outcome.placeName) {
            await this.eventService.update(context, candidate.event_id, {
              location_name: outcome.placeName,
            });
            await this.tagLocationSource(context, candidate.event_id, 'reverse_geocoded');
            resolved++;

            return;
          }

          if (outcome.retryable) {
            // Exhausted retries on a transient failure — leave for the next run.
            failed++;

            return;
          }

          // Non-retryable negative result (ZERO_RESULTS / REQUEST_DENIED /
          // INVALID_REQUEST). Cached in geocode_cache so the next run skips the
          // provider call entirely.
          skipped++;
        }),
      ),
    );

    this.logger.log('Completed reverse-geocode backfill batch', {
      userId,
      resolved,
      failed,
      skipped,
      candidateCount: candidates.length,
    });
  }

  /** Reverse-geocode with the same backoff/throttle contract as the forward path. */
  private async reverseGeocodeWithRetry(
    lat: number,
    lng: number,
    bustCache: boolean,
  ): Promise<ReverseGeocodeOutcome> {
    await this.rateLimiter.acquire();
    let outcome = await this.geocodeService.reverseGeocode(lat, lng, { bustCache });

    for (let attempt = 0; outcome.retryable && attempt < BACKOFF_MS.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
      await this.rateLimiter.acquire();
      outcome = await this.geocodeService.reverseGeocode(lat, lng, { bustCache: true });
    }

    if (outcome.retryable && RETRYABLE_STATUSES.has(outcome.status)) {
      this.logger.warn('Reverse-geocode exhausted retries', { lat, lng, status: outcome.status });
    }

    return outcome;
  }

  /**
   * Select the reverse-backfill candidate set: events for this user that HAVE
   * coordinates but no usable location_name. lat/lng are projected out of the
   * geography Point with ST_Y/ST_X (PostGIS stores [lng, lat]).
   */
  private async selectReverseCandidates(
    userId: string,
    opts: { eventIds?: string[]; limit: number },
  ): Promise<ReverseCandidateRow[]> {
    const query = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .select('event.event_id', 'event_id')
      .addSelect('ST_Y(event.location_coordinates::geometry)', 'lat')
      .addSelect('ST_X(event.location_coordinates::geometry)', 'lng')
      .where('event.user_id = :userId', { userId })
      .andWhere('event.location_coordinates IS NOT NULL');

    if (opts.eventIds && opts.eventIds.length > 0) {
      query.andWhere('event.event_id IN (:...eventIds)', { eventIds: opts.eventIds });
    } else {
      query.andWhere("(event.location_name IS NULL OR btrim(event.location_name) = '')");
    }

    query.orderBy('event.start_time', 'DESC').limit(opts.limit);

    return query.getRawMany<ReverseCandidateRow>();
  }

  /**
   * Select the backfill candidate set: events for this user that have a
   * non-empty location_name.
   *
   * - Default (retryNull = false): only events still missing coordinates AND not
   *   already tagged terminal — i.e. previously resolved-virtual
   *   (metadata.location_source = 'virtual') rows are excluded so a denylisted
   *   venue is not re-walked every run.
   * - retryNull = true: re-attempt the NULL-coordinate set INCLUDING rows a
   *   prior run tagged 'virtual' or negative-cached, paired with a cache-bust in
   *   the worker so the provider is actually re-queried (e.g. after a key change
   *   or a denylist/heuristic fix). This is what makes retryNull do real work —
   *   previously it resolved to the same NULL filter and never re-attempted.
   *
   * An explicit eventIds list overrides the auto-selection but is still scoped
   * to the user.
   */
  private async selectCandidates(
    userId: string,
    opts: { eventIds?: string[]; limit: number; retryNull: boolean },
  ): Promise<CandidateRow[]> {
    const query = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .select('event.event_id', 'event_id')
      .addSelect('event.location_name', 'location_name')
      .where('event.user_id = :userId', { userId })
      .andWhere('event.location_name IS NOT NULL')
      .andWhere("btrim(event.location_name) <> ''");

    if (opts.eventIds && opts.eventIds.length > 0) {
      // Explicit set: scoped to the user but not filtered on existing
      // coordinates, so a caller can force a re-geocode of specific events.
      query.andWhere('event.event_id IN (:...eventIds)', { eventIds: opts.eventIds });
    } else {
      // Auto-selection always requires NULL coordinates — a resolved coordinate
      // is never re-billed.
      query.andWhere('event.location_coordinates IS NULL');

      if (!opts.retryNull) {
        // Skip rows a prior run tagged virtual so they aren't re-walked every
        // backfill. With retryNull these ARE included (re-attempted).
        query.andWhere("COALESCE(event.metadata->>'location_source', '') <> 'virtual'");
      }
    }

    query.orderBy('event.start_time', 'DESC').limit(opts.limit);

    return query.getRawMany<CandidateRow>();
  }

  /**
   * Record metadata.location_source (e.g. 'virtual' for a denylisted venue,
   * 'approximate' for a coarse city-centroid hit, 'reverse_geocoded' for a name
   * resolved from coordinates) without touching coordinates.
   */
  private async tagLocationSource(
    context: UserServiceContext,
    eventId: string,
    source: 'virtual' | 'approximate' | 'reverse_geocoded',
  ): Promise<void> {
    const event = await this.eventService.findById(context, eventId);
    if (!event) {
      return;
    }

    await this.eventService.update(context, eventId, {
      metadata: { ...event.metadata, location_source: source },
    });
  }
}
