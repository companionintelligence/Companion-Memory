import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type Point } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { isOutboundEnabled } from '@ci/common/outbound';
import config from '@ci/configuration';

import { GeocodeCacheEntity } from '../entities/GeocodeCacheEntity';
import { isVirtualLocation } from '../util/virtualLocations';

import {
  GEOCODE_PROVIDER,
  type GeocodeBounds,
  type GeocodeProvider,
  type GeocodeProviderResult,
} from './GeocodeProvider';

/**
 * Rehydrate a cached bounding box. The column is untyped jsonb (and may hold a
 * row written before the column existed, or by an older shape), so every corner
 * is re-validated on the way out rather than trusted.
 */
function toGeocodeBounds(raw: Record<string, number> | null | undefined): GeocodeBounds | null {
  const north = raw?.north;
  const south = raw?.south;
  const east = raw?.east;
  const west = raw?.west;

  if (
    typeof north !== 'number' ||
    typeof south !== 'number' ||
    typeof east !== 'number' ||
    typeof west !== 'number' ||
    !Number.isFinite(north) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(west) ||
    north <= south ||
    east <= west
  ) {
    return null;
  }

  return { north, south, east, west };
}

/** Provider statuses that must NOT be retried — the answer will never change. */
export const NON_RETRYABLE_STATUSES = new Set<string>(['REQUEST_DENIED', 'INVALID_REQUEST', 'ZERO_RESULTS']);

/** Provider statuses that are transient and should be retried with backoff. */
export const RETRYABLE_STATUSES = new Set<string>(['OVER_QUERY_LIMIT', 'UNKNOWN_ERROR']);

/** Synthetic status for denylisted non-physical "locations". */
export const VIRTUAL_STATUS = 'virtual';

/**
 * Synthetic status: the user has turned place lookups off (Settings -> Privacy
 * -> "What leaves your appliance"), so no request was made.
 *
 * ── What this outcome means, and why it is shaped the way it is ────────────
 *
 * It is returned with `retryable: true`, and that is a deliberate borrowing of
 * an existing contract rather than a new one. Every caller already has a
 * defined response to "the provider could not be asked right now, try again
 * later", and that response is exactly right for "the user has not allowed it":
 *
 *  - the pipeline stages (`enrich.geocode`, `enrich.event_reverse`,
 *    `enrich.position_reverse`) record `failed: provider_unavailable`, which is
 *    in `TRANSIENT_FAILURE_REASONS` — the attempt is refunded, the row backs off
 *    and is retried, and it can NEVER reach quarantine on this account;
 *  - `GeocodeBatchListener` leaves the event untouched ("left for the next
 *    run"), because its candidate query is derived from event state and not from
 *    a ledger;
 *  - the interactive and ETL callers already treat any non-OK status as "no
 *    answer" and carry on.
 *
 * What it must never be is a NEGATIVE result. `ZERO_RESULTS` / `REQUEST_DENIED`
 * are written to `ci.geocode_cache` and become `skipped` ledger rows that only a
 * stage-version bump re-opens — so a user who flipped the switch off for a week
 * and back on would find every place lookup they had queued permanently decided
 * "not found". Hence: no cache row is written here (the return is BEFORE the
 * provider call and before `writeCache`), and the status is a transient one.
 *
 * The pipeline additionally HOLDS these stages while the switch is off
 * (`domains/pipeline/outboundHolds.ts`), so in the normal case a row is never
 * claimed at all and no `failed` ledger row is written either; this outcome is
 * the backstop for every caller the hold does not cover and for a slice that was
 * already running when the switch was flipped.
 *
 * Cached answers are still served while the switch is off: a cache hit is local
 * data and no request leaves the box.
 */
export const OUTBOUND_DISABLED_STATUS = 'OUTBOUND_DISABLED';

/**
 * Confidence scores by Google geometry.location_type. Inferred / coarse coords
 * MUST NOT carry the default 1.0 — HBPE and RAG treat confidence_score == 1.0 as
 * ground truth, and a city-centroid pinned at 1.0 would mislead them.
 *   ROOFTOP / RANGE_INTERPOLATED  -> 0.95 (precise street address)
 *   GEOMETRIC_CENTER              -> 0.8  (a venue / named place center)
 *   APPROXIMATE                   -> 0.4  (city / region centroid)
 */
export const APPROXIMATE_CONFIDENCE = 0.4;

/**
 * Confidence at or below this threshold is "coarse" — a city/region centroid,
 * not a real venue. The batch listener tags these (metadata.location_source =
 * 'approximate') so the coordinate is distinguishable from a precise hit. A
 * non-address free-text label ("Mom's", "the usual spot") that slips past the
 * virtual denylist resolves to exactly such a centroid, so this is the signal
 * that flags it downstream.
 */
export const LOW_CONFIDENCE_THRESHOLD = APPROXIMATE_CONFIDENCE;

export function confidenceForLocationType(locationType: string | null | undefined): number {
  switch (locationType) {
    case 'ROOFTOP':
    case 'RANGE_INTERPOLATED':
      return 0.95;
    case 'GEOMETRIC_CENTER':
      return 0.8;
    case 'APPROXIMATE':
      return 0.4;
    default:
      // Unknown precision — be conservative, treat as venue-grade.
      return 0.8;
  }
}

/** Outcome of a geocode attempt, surfaced to the batch listener. */
export interface GeocodeOutcome {
  /** Provider status, the synthetic 'virtual', or 'OK'. */
  status: string;
  /** PostGIS-ready Point ([lng, lat], SRID 4326) when status === 'OK'. */
  point: Point | null;
  /** Confidence for the resolved coordinates (see confidenceForLocationType). */
  confidence: number | null;
  /** True when the resolution came from the cache (no provider call billed). */
  cached: boolean;
  /** Whether a retry is worthwhile (transient provider failure). */
  retryable: boolean;
  /**
   * True when status === 'OK' but the confidence is coarse (<= 0.4, an
   * APPROXIMATE city/region centroid). Lets callers tag the resolved coordinate
   * as low-precision so it is distinguishable from a real venue/street hit.
   */
  lowConfidence?: boolean;
  normalizedAddress?: string | null;
  locationType?: string | null;
  /** Provider's stable place id — the strongest place-dedupe key. */
  placeId?: string | null;
  /** Provider address components ({address_components: [...]}) for hierarchy. */
  components?: Record<string, unknown> | null;
  /** Result bounding box for a place footprint, when the provider gave one. */
  bounds?: GeocodeBounds | null;
}

/** Outcome of a reverse-geocode attempt (coords -> place name). */
export interface ReverseGeocodeOutcome {
  /** Provider status, or 'OK'. */
  status: string;
  /** Resolved human-readable place name, present only when status === 'OK'. */
  placeName: string | null;
  /** True when served from the cache (no provider call billed). */
  cached: boolean;
  /** Whether a retry is worthwhile (transient provider failure). */
  retryable: boolean;
  /** Provider's stable place id — the strongest place-dedupe key. */
  placeId?: string | null;
  /** Provider address components ({address_components: [...]}) for hierarchy. */
  components?: Record<string, unknown> | null;
  /** Result bounding box for a place footprint, when the provider gave one. */
  bounds?: GeocodeBounds | null;
}

/**
 * Token-bucket / minimum-interval QPS throttle. `acquire()` resolves no sooner
 * than `1000 / qps` ms after the previous acquisition, so a burst of concurrent
 * calls is spaced out rather than firing at once and tripping the provider's
 * own rate limit (OVER_QUERY_LIMIT).
 *
 * Exported so a caller with its own separate concurrency ceiling (a p-limit
 * cap on in-flight calls, which bounds sockets/memory) can still be tested in
 * isolation — but the instance that actually matters is
 * {@link GeocodeService}'s own, applied inside {@link GeocodeService.geocode}
 * and {@link GeocodeService.reverseGeocode}. Constructing a second `RateLimiter`
 * anywhere else recreates the bug this class exists to fix: two independent
 * budgets that each individually respect `config.geocoding.rateLimitPerSecond`
 * while the provider sees their sum.
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

function outboundDisabledOutcome(): GeocodeOutcome {
  return {
    status: OUTBOUND_DISABLED_STATUS,
    point: null,
    confidence: null,
    cached: false,
    retryable: true,
  };
}

/** Options controlling a single {@link GeocodeService.geocode} call. */
export interface GeocodeOptions {
  /**
   * Skip the cache lookup and force a fresh provider call, then overwrite the
   * cache row. Used by `retryNull` backfills to re-attempt locations a prior run
   * negative-cached (ZERO_RESULTS / REQUEST_DENIED / INVALID_REQUEST). The
   * virtual denylist is still honored — busting the cache never sends a
   * denylisted virtual venue to the provider.
   */
  bustCache?: boolean;
}

@Injectable()
export class GeocodeService {
  /**
   * The ONE QPS throttle for the metered provider. GeocodeService is a Nest
   * singleton — every caller (`GeocodeBatchListener`, `GeocodeStage`,
   * `PositionReverseStage`, and anything else that geocodes through this
   * service) is handed the same instance, so this field is the appliance-wide
   * budget rather than one budget per caller. Each caller may still keep its
   * own concurrency ceiling (p-limit, bounding in-flight sockets/memory), but
   * the rate at which calls actually reach the provider is decided HERE and
   * nowhere else.
   */
  private readonly rateLimiter = new RateLimiter(config.geocoding.rateLimitPerSecond);

  constructor(
    @InjectRepository(GeocodeCacheEntity)
    private readonly cacheRepository: Repository<GeocodeCacheEntity>,
    @Inject(GEOCODE_PROVIDER)
    private readonly provider: GeocodeProvider,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GeocodeService.name);
  }

  /**
   * Canonical form used for the cache key: trim, lowercase, collapse internal
   * whitespace, strip punctuation. Keeps "123 Main St.", "123 Main St" and
   * "123  main st" mapping to a single cache row. The normalization rule lives
   * here (one place) and is hashed (sha256) to form the PK.
   */
  static canonicalize(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static hashQuery(raw: string): string {
    return createHash('sha256').update(GeocodeService.canonicalize(raw)).digest('hex');
  }

  /**
   * Cache key for a REVERSE lookup: the coordinate pair rounded to 4 decimals
   * (~11 m, so nearby pins share a cached label) under a `reverse:` namespace
   * that cannot collide with a forward address hash.
   *
   * Extracted from {@link reverseGeocode} so that a READER of those rows —
   * `promote.place_position` reads them by primary key for the address
   * components `enrich.position_reverse` already paid for — computes the same
   * key rather than re-deriving it. A second copy of this expression is a
   * silent cache miss on the day one of them changes, and a silent cache miss
   * reads as "this place has no hierarchy", not as a bug.
   */
  static reverseCacheKey(lat: number, lng: number): string {
    return `reverse:${lat.toFixed(4)},${lng.toFixed(4)}`;
  }

  /**
   * `ci.geocode_cache.query_hash` for a reverse lookup.
   *
   * Hashes the structured key DIRECTLY — do NOT route it through
   * {@link hashQuery}, whose `canonicalize()` strips '-', '.' and ',' (it is
   * built for free-text addresses). That would collapse all four coordinate
   * quadrants into one cache row (37.42,-122.08 vs -37.42,122.08 vs ...), so
   * the first quadrant to resolve poisons the others with a wrong-hemisphere
   * place name.
   */
  static hashReverseQuery(lat: number, lng: number): string {
    return createHash('sha256').update(GeocodeService.reverseCacheKey(lat, lng)).digest('hex');
  }

  /**
   * Build the PostGIS geography Point from a (lat, lng) pair. PostGIS / GeoJSON
   * order coordinates [lng, lat] (X, Y) — the same axis order CalendarEventService and
   * TransformGoogleCalendar write. Guarded so an accidental swap can't silently
   * persist a transposed coordinate.
   */
  static toPoint(lat: number, lng: number): Point {
    if (lat < -90 || lat > 90) {
      throw new Error(`Invalid latitude ${lat}: out of [-90, 90] range (lat/lng likely swapped)`);
    }

    if (lng < -180 || lng > 180) {
      throw new Error(`Invalid longitude ${lng}: out of [-180, 180] range`);
    }

    return { type: 'Point', coordinates: [lng, lat] };
  }

  /**
   * Forward-geocode a single location string, going through the cache and the
   * virtual-location denylist. Never throws on provider-level failures: those
   * are returned as a status on the outcome.
   */
  async geocode(location: string | null | undefined, options: GeocodeOptions = {}): Promise<GeocodeOutcome> {
    if (!location || location.trim().length === 0) {
      return { status: 'ZERO_RESULTS', point: null, confidence: null, cached: false, retryable: false };
    }

    // Denylisted virtual venues are never sent to Google — even on a cache-bust.
    if (isVirtualLocation(location)) {
      return {
        status: VIRTUAL_STATUS,
        point: null,
        confidence: null,
        cached: false,
        retryable: false,
      };
    }

    const queryHash = GeocodeService.hashQuery(location);

    // --- Cache check -------------------------------------------------------
    // bustCache skips the read so a retryNull backfill can re-attempt a row a
    // prior run negative-cached; the provider result then overwrites the row.
    if (!options.bustCache) {
      const cached = await this.cacheRepository.findOne({ where: { queryHash } });
      if (cached) {
        // Bump hit_count opportunistically; never let it fail the read.
        await this.cacheRepository.increment({ queryHash }, 'hitCount', 1).catch(() => undefined);

        return this.outcomeFromCache(cached);
      }
    }

    // --- The user's switch -------------------------------------------------
    // The single point every forward lookup passes through on its way to the
    // provider, so it is the one place the switch is enforced: no request, no
    // throttle slot spent, and — the part that matters — no cache row written.
    // See OUTBOUND_DISABLED_STATUS for why this is `retryable`.
    if (!isOutboundEnabled('place_lookups')) {
      return outboundDisabledOutcome();
    }

    // --- Provider call -----------------------------------------------------
    // The shared appliance-wide throttle. Applied AFTER the cache check (a hit
    // never waits) and BEFORE the network call, so every caller of this method
    // — regardless of which pipeline queue it runs on — draws from the same
    // budget.
    await this.rateLimiter.acquire();

    let result: GeocodeProviderResult;
    try {
      result = await this.provider.geocode(location.trim());
    } catch (error) {
      // Transport failure (network/timeout) — transient, retryable, NOT cached.
      this.logger.warn('Geocode provider transport error', {
        location,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return { status: 'UNKNOWN_ERROR', point: null, confidence: null, cached: false, retryable: true };
    }

    // Transient provider statuses are not cached (the next attempt may succeed).
    if (RETRYABLE_STATUSES.has(result.status)) {
      return {
        status: result.status,
        point: null,
        confidence: null,
        cached: false,
        retryable: true,
      };
    }

    await this.writeCache(location, queryHash, result);

    if (result.status === 'OK' && typeof result.lat === 'number' && typeof result.lng === 'number') {
      const point = GeocodeService.toPoint(result.lat, result.lng);
      const confidence = confidenceForLocationType(result.locationType);

      return {
        status: 'OK',
        point,
        confidence,
        cached: false,
        retryable: false,
        lowConfidence: confidence <= LOW_CONFIDENCE_THRESHOLD,
        normalizedAddress: result.normalizedAddress ?? null,
        locationType: result.locationType ?? null,
        placeId: result.placeId ?? null,
        components: result.components ?? null,
        bounds: result.bounds ?? null,
      };
    }

    // Negative result (ZERO_RESULTS / REQUEST_DENIED / INVALID_REQUEST) — cached
    // above so we never re-bill it.
    return {
      status: result.status,
      point: null,
      confidence: null,
      cached: false,
      retryable: false,
    };
  }

  /**
   * Reverse-geocode a (lat, lng) pair into a human-readable place name, going
   * through the same cache table as forward geocoding. The cache key is the
   * rounded coordinate pair under a `reverse:` namespace (so it never collides
   * with a forward address hash); rounding to 4 decimals (~11 m) lets nearby
   * pins share a cached label. Never throws on provider-level failures.
   */
  async reverseGeocode(
    lat: number,
    lng: number,
    options: GeocodeOptions = {},
  ): Promise<ReverseGeocodeOutcome> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { status: 'INVALID_REQUEST', placeName: null, cached: false, retryable: false };
    }

    // Both from the statics above, so the writer here and the readers of these
    // rows (`promote.place_position`) can never disagree about the key.
    const cacheKey = GeocodeService.reverseCacheKey(lat, lng);
    const queryHash = GeocodeService.hashReverseQuery(lat, lng);

    // --- Cache check -------------------------------------------------------
    if (!options.bustCache) {
      const cached = await this.cacheRepository.findOne({ where: { queryHash } });
      if (cached) {
        await this.cacheRepository.increment({ queryHash }, 'hitCount', 1).catch(() => undefined);

        return {
          status: cached.status,
          placeName: cached.status === 'OK' ? (cached.normalizedAddress ?? null) : null,
          cached: true,
          retryable: false,
          placeId: cached.placeId ?? null,
          components: cached.components ?? null,
          bounds: toGeocodeBounds(cached.bounds),
        };
      }
    }

    // --- The user's switch -------------------------------------------------
    // Same gate, same reasoning, as the forward path: before the throttle and
    // before any cache write. A reverse lookup is the one an interactive caller
    // ("use my location" when adding a place) is most likely to be waiting on;
    // it gets an ordinary empty result carrying this status, not an error.
    if (!isOutboundEnabled('place_lookups')) {
      return { status: OUTBOUND_DISABLED_STATUS, placeName: null, cached: false, retryable: true };
    }

    // --- Provider call -----------------------------------------------------
    // Same shared throttle as the forward path — one budget for both directions.
    await this.rateLimiter.acquire();

    let result: GeocodeProviderResult;
    try {
      result = await this.provider.reverseGeocode(lat, lng);
    } catch (error) {
      // Transport failure (network/timeout) — transient, retryable, NOT cached.
      this.logger.warn('Reverse-geocode provider transport error', {
        lat,
        lng,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return { status: 'UNKNOWN_ERROR', placeName: null, cached: false, retryable: true };
    }

    // Transient provider statuses are not cached (the next attempt may succeed).
    if (RETRYABLE_STATUSES.has(result.status)) {
      return { status: result.status, placeName: null, cached: false, retryable: true };
    }

    await this.writeCache(cacheKey, queryHash, result);

    if (result.status === 'OK' && result.normalizedAddress) {
      return {
        status: 'OK',
        placeName: result.normalizedAddress,
        cached: false,
        retryable: false,
        placeId: result.placeId ?? null,
        components: result.components ?? null,
        bounds: result.bounds ?? null,
      };
    }

    // Negative result (ZERO_RESULTS / REQUEST_DENIED / INVALID_REQUEST) — cached
    // above so we never re-bill it.
    return { status: result.status, placeName: null, cached: false, retryable: false };
  }

  private outcomeFromCache(row: GeocodeCacheEntity): GeocodeOutcome {
    if (row.status === 'OK' && typeof row.lat === 'number' && typeof row.lng === 'number') {
      const confidence = confidenceForLocationType(row.locationType);

      return {
        status: 'OK',
        point: GeocodeService.toPoint(row.lat, row.lng),
        confidence,
        cached: true,
        retryable: false,
        lowConfidence: confidence <= LOW_CONFIDENCE_THRESHOLD,
        normalizedAddress: row.normalizedAddress,
        locationType: row.locationType,
        placeId: row.placeId ?? null,
        components: row.components ?? null,
        bounds: toGeocodeBounds(row.bounds),
      };
    }

    return {
      status: row.status,
      point: null,
      confidence: null,
      cached: true,
      retryable: false,
    };
  }

  /**
   * Upsert the cache row. ON CONFLICT (query_hash) refreshes the payload and
   * bumps hit_count — a concurrent writer (or a re-run) may have created it. The
   * raw SQL keeps the `hit_count + 1` / `now()` expressions explicit; the query
   * builder's orUpdate cannot express either cleanly.
   */
  private async writeCache(
    rawQuery: string,
    queryHash: string,
    result: GeocodeProviderResult,
  ): Promise<void> {
    try {
      await this.cacheRepository.query(
        `INSERT INTO ci.geocode_cache
           (query_hash, raw_query, normalized_address, place_id, lat, lng,
            components, status, partial_match, location_type, bounds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (query_hash) DO UPDATE SET
           raw_query          = EXCLUDED.raw_query,
           normalized_address = EXCLUDED.normalized_address,
           place_id           = EXCLUDED.place_id,
           lat                = EXCLUDED.lat,
           lng                = EXCLUDED.lng,
           components         = EXCLUDED.components,
           status             = EXCLUDED.status,
           partial_match      = EXCLUDED.partial_match,
           location_type      = EXCLUDED.location_type,
           bounds             = EXCLUDED.bounds,
           hit_count          = ci.geocode_cache.hit_count + 1,
           updated_at         = now()`,
        [
          queryHash,
          rawQuery.trim(),
          result.normalizedAddress ?? null,
          result.placeId ?? null,
          typeof result.lat === 'number' ? result.lat : null,
          typeof result.lng === 'number' ? result.lng : null,
          JSON.stringify(result.components ?? {}),
          result.status,
          result.partialMatch ?? false,
          result.locationType ?? null,
          result.bounds ? JSON.stringify(result.bounds) : null,
        ],
      );
    } catch (error) {
      // The cache is best-effort; a write failure must not abort the geocode.
      this.logger.warn('Failed to write geocode cache row', {
        queryHash,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
