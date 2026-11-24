import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import plimit from 'p-limit';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { isOutboundEnabled } from '@ci/common/outbound';
import config from '@ci/configuration';
import { OnEvent } from '@ci/domains/events';
import { EventEntity, CalendarEventService, EVENT_HAPPENED_SQL, PlaceService } from '@ci/domains/memory';
import { GeocodeBatchRequestEvent, type GeocodeBatchRequestPayload } from '@ci/domains/memory/events';

import {
  GeocodeService,
  OUTBOUND_DISABLED_STATUS,
  RETRYABLE_STATUSES,
  VIRTUAL_STATUS,
  type ReverseGeocodeOutcome,
} from '../services/GeocodeService';

/** Dedicated PGBoss queue so geocode backfills don't block the default queue. */
const GEOCODE_QUEUE = 'geocode';

/**
 * Hard concurrency ceiling on in-flight provider calls. Well under Google's 25
 * QPS, it bounds memory / open sockets even if rateLimitPerSecond were
 * misconfigured high.
 *
 * This is NOT the QPS throttle — that lives in {@link GeocodeService} (a Nest
 * singleton shared with `GeocodeStage` and `PositionReverseStage`), so it is
 * the one budget for every caller combined, not one per caller. This constant
 * only bounds how many of THIS listener's calls may be in flight at once.
 */
const MAX_CONCURRENCY = 10;

/** Exponential-backoff schedule (ms) for transient provider failures. */
const BACKOFF_MS = [500, 1500, 4000];

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

/** What the provider resolved about a place beyond its name and coordinate. */
interface PlaceResolution {
  placeId?: string | null;
  components?: Record<string, unknown> | null;
  bounds?: { north: number; south: number; east: number; west: number } | null;
}

/**
 * Consumes {@link GeocodeBatchRequestEvent}: selects events carrying a
 * location_name but no location_coordinates (the backfill set), forward-geocodes
 * each via {@link GeocodeService}, and writes location_coordinates +
 * confidence_score back through {@link CalendarEventService.update}.
 *
 * Idempotent: the candidate query excludes already-geocoded events, and a
 * re-run updates in place (CalendarEventService.update is keyed on event_id), so it can
 * be enqueued repeatedly without duplicating work.
 *
 * It also writes `location_entity_id`, the link `promote.place` writes, and it
 * applies that stage's rule to it: an event that did not happen (deleted,
 * predicted, cancelled, no_show, skipped, or a cancelled Takeout reservation;
 * see {@link EVENT_HAPPENED_SQL}) is geocoded like any other but is not linked.
 * The coordinate is a fact about the venue. The link says the user went, and it
 * is read as a visit, a footprint and a LOCATED_AT edge. The rule is asked per
 * event, after the provider answers, because a batch is minutes of provider
 * calls and a sync can cancel a meeting meanwhile. An event refused its link
 * gets it from `promote.place` if it is reinstated: that stage offers an event
 * only while it passes the same rule, so a reinstated one is picked up on its
 * next sweep with no version bump.
 *
 * This is not an operator-only leftover. The orchestrator's `geocode` and
 * `reverse_geocode` legs enqueue it, and they run after every bulk `/v1` ingest
 * (`IngestCoalesceService`, `ingest.selfHeal`, on by default) as well as from the
 * maintenance endpoints. Its links do not re-open `promote.edge_event` the way
 * `promote.place`'s do (`pipeline/reopens.ts`); that gap is separate, and this
 * class does not close it.
 */
@Injectable()
export class GeocodeBatchListener {
  /** Concurrency cap: min(MAX_CONCURRENCY, configured QPS) — never exceed either. */
  private readonly limiter = plimit(Math.min(MAX_CONCURRENCY, config.geocoding.rateLimitPerSecond));

  /** Default batch size from config.geocoding.batchSize (default 200). */
  private readonly defaultLimit = config.geocoding.batchSize;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly geocodeService: GeocodeService,
    private readonly eventService: CalendarEventService,
    private readonly placeService: PlaceService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GeocodeBatchListener.name);
  }

  @OnEvent(GeocodeBatchRequestEvent, { queue: GEOCODE_QUEUE })
  async handleBatch(payload: GeocodeBatchRequestPayload): Promise<void> {
    const { userId, eventIds, limit, retryNull, direction } = payload;
    const retry = retryNull ?? false;
    const batchLimit = limit ?? this.defaultLimit;

    // The user has turned place lookups off. Stop before selecting candidates:
    // nothing here would be sent, and walking up to `batchLimit` events only to
    // have each one turned away (after the retry sleeps below) would be a
    // minutes-long no-op. Nothing is recorded either. This listener keeps no
    // ledger — its candidate query is derived from event state (no coordinates /
    // no name) — so the events stay exactly as eligible as they were and the
    // next backfill after the user switches lookups back on picks them up.
    if (!isOutboundEnabled('place_lookups')) {
      this.logger.log('Geocode backfill batch skipped: place lookups are turned off', {
        userId,
        direction: direction ?? 'forward',
      });

      return;
    }

    // Reverse direction (coords -> name) shares this queue, and shares
    // GeocodeService's rate limiter with every other caller, so the two never
    // collectively exceed the provider's QPS.
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
    let unlinked = 0;
    let virtual = 0;
    let failed = 0;
    let skipped = 0;

    await Promise.all(
      candidates.map((candidate) =>
        this.limiter(async () => {
          const outcome = await this.geocodeWithRetry(candidate.location_name, retry);

          if (outcome.status === 'OK' && outcome.point && outcome.confidence !== null) {
            // PostGIS Point.coordinates is [lng, lat] (GeoJSON order).
            const [lng, lat] = outcome.point.coordinates;
            // The coordinate below is written either way; the Place link only
            // for an event that happened.
            const { place, happened } = await this.placeForEvent(
              context,
              candidate.event_id,
              candidate.location_name,
              lat,
              lng,
              {
                placeId: outcome.placeId,
                components: outcome.components,
                bounds: outcome.bounds,
              },
            );

            await this.eventService.update(context, candidate.event_id, {
              location_coordinates: outcome.point,
              // Inferred / coarse coords carry < 1.0 so HBPE/RAG don't treat
              // them as ground truth.
              confidence_score: outcome.confidence,
              ...(place && { location_entity_id: place.id }),
            });
            // A coarse APPROXIMATE centroid (<= 0.4) — likely a non-address
            // label that slipped past the denylist resolving to a city center.
            // Tag it so it is distinguishable from a precise street/venue hit.
            if (outcome.lowConfidence) {
              await this.tagLocationSource(context, candidate.event_id, 'approximate');
            }

            resolved++;
            if (!happened) {
              unlinked++;
            }

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
      // Resolved, but the event did not happen, so no Place link was written.
      unlinked,
      virtual,
      skipped,
      failed,
      candidateCount: candidates.length,
    });
  }

  /**
   * Geocode with exponential backoff on transient provider failures. Non-
   * retryable statuses (and successes) return immediately. The QPS throttle
   * lives inside {@link GeocodeService.geocode} itself now (shared with every
   * other caller), so this loop just calls it — a cache hit still short-
   * circuits before any network call, and before any wait. `bustCache`
   * re-attempts a previously negative-cached location (the retryNull path).
   */
  private async geocodeWithRetry(location: string, bustCache: boolean) {
    let outcome = await this.geocodeService.geocode(location, { bustCache });

    for (
      let attempt = 0;
      outcome.retryable && outcome.status !== OUTBOUND_DISABLED_STATUS && attempt < BACKOFF_MS.length;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
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
   * Reverse-geocode backfill: events that have MEASURED coordinates (photo EXIF /
   * GPS) but no readable location_name get one, so a bare map pin gains a label.
   * An estimated coordinate is never named — see {@link selectReverseCandidates}.
   * Idempotent — a resolved row now HAS a name and drops out of the candidate
   * set; re-runs serve negative results from the geocode cache.
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
    let unlinked = 0;
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
            const lat = Number(candidate.lat);
            const lng = Number(candidate.lng);
            // The name below is written either way; the Place link only for an
            // event that happened.
            const { place, happened } = await this.placeForEvent(
              context,
              candidate.event_id,
              outcome.placeName,
              lat,
              lng,
              {
                placeId: outcome.placeId,
                components: outcome.components,
                bounds: outcome.bounds,
              },
            );

            await this.eventService.update(context, candidate.event_id, {
              location_name: outcome.placeName,
              ...(place && { location_entity_id: place.id }),
            });
            await this.tagLocationSource(context, candidate.event_id, 'reverse_geocoded');
            resolved++;
            if (!happened) {
              unlinked++;
            }

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
      // Resolved, but the event did not happen, so no Place link was written.
      unlinked,
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
    let outcome = await this.geocodeService.reverseGeocode(lat, lng, { bustCache });

    // A switched-off outcome is retryable in the sense that a LATER run may
    // succeed, but sleeping and asking again now cannot — the user's answer will
    // not change in six seconds — so it is excluded from the in-line backoff.
    for (
      let attempt = 0;
      outcome.retryable && outcome.status !== OUTBOUND_DISABLED_STATUS && attempt < BACKOFF_MS.length;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
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
   *
   * An ESTIMATED coordinate (metadata.location_source = 'estimated') is never a
   * candidate, in the auto-selection or in an explicit eventIds set — which
   * otherwise bypasses every filter here, the name check included. The
   * estimator copies a temporally-neighbouring fix onto an event that had none,
   * so naming it turns "probably somewhere near here" into "at this address",
   * and linkPlace then records a visit to that Place that never happened. The
   * 'reverse_geocoded' tag written afterwards also replaces the 'estimated'
   * marker, after which nothing downstream can tell the row from a measured
   * one: the estimator takes it as a donor, and EventReverseStage — which
   * refuses estimates with `skipped: coordinates_estimated` for exactly this
   * reason — treats its name as one it owns. COALESCE because a measured row
   * usually has no location_source at all, and `NULL <> 'estimated'` is NULL,
   * not true.
   *
   * Whether the event happened is not asked here either; see
   * {@link selectCandidates}. A cancelled event's measured coordinate is still
   * named, and still not linked ({@link placeForEvent}).
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
      .andWhere('event.location_coordinates IS NOT NULL')
      .andWhere("COALESCE(event.metadata->>'location_source', '') <> 'estimated'");

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
   *
   * Nothing here asks whether the event happened, on purpose. Geocoding a
   * cancelled meeting's venue is right (`enrich.geocode` does it too), and
   * dropping such rows here would also make an explicit eventIds request for
   * one a silent no-op. What it must not get is a Place link, which is decided
   * per event in {@link placeForEvent}. The operator-facing candidate counts
   * (MaintenanceController, MaintenanceOrchestratorService) therefore still
   * mirror this filter exactly.
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
   * The Place to link an event to, and whether the event happened — which is
   * why `place` is null when it is.
   *
   * An event that did not happen gets no Place at all: not a link, and not the
   * Location entity {@link linkPlace} would mint for its venue, which would sit
   * in the graph with no visit behind it. The caller still writes the
   * coordinate or name it resolved.
   */
  private async placeForEvent(
    context: UserServiceContext,
    eventId: string,
    name: string,
    lat: number,
    lng: number,
    resolution: PlaceResolution,
  ): Promise<{ place: { id: string } | null; happened: boolean }> {
    if (!(await this.eventHappened(context, eventId))) {
      return { place: null, happened: false };
    }

    return { place: await this.linkPlace(context, name, lat, lng, resolution), happened: true };
  }

  /**
   * Whether the event happened ({@link EVENT_HAPPENED_SQL}), read now rather than
   * carried over from {@link selectCandidates}. A batch is up to
   * `config.geocoding.batchSize` provider calls with a backoff of up to six
   * seconds each, and a calendar sync that cancels a meeting while one is in
   * flight must not be answered with a link saying the user was there. One
   * primary-key read per resolved candidate, beside a paid provider call.
   *
   * Fails closed. An event that cannot be read — hard-deleted mid-batch, or not
   * this user's — is not one this listener has any business linking.
   *
   * The table is aliased `event` because that is the alias
   * {@link EVENT_HAPPENED_SQL} is written for.
   */
  private async eventHappened(context: UserServiceContext, eventId: string): Promise<boolean> {
    const rows: Array<{ happened: boolean | null }> = await this.dataSource.query(
      `SELECT ${EVENT_HAPPENED_SQL} AS happened
         FROM ci.events event
        WHERE event.event_id = $1
          AND event.user_id = $2`,
      [eventId, context.userId],
    );

    return rows[0]?.happened === true;
  }

  /**
   * Idempotent upsert of the {@link PlaceEntity} for a (name, lat, lng) tuple
   * so the event can carry `location_entity_id` and "events at <place>" queries
   * can traverse the graph. Returns null on any failure — the caller proceeds
   * with the coordinate/name update so a transient Place-write error never
   * blocks geocoding progress.
   */
  private async linkPlace(
    context: UserServiceContext,
    name: string,
    lat: number,
    lng: number,
    resolution: PlaceResolution = {},
  ): Promise<{ id: string } | null> {
    try {
      return await this.placeService.findOrCreateForGeocode(context, {
        name,
        lat,
        lng,
        placeId: resolution.placeId ?? null,
        components: resolution.components ?? null,
        bounds: resolution.bounds ?? null,
      });
    } catch (error) {
      this.logger.warn('Failed to find-or-create place for geocoded event', {
        userId: context.userId,
        name,
        lat,
        lng,
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    }
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
