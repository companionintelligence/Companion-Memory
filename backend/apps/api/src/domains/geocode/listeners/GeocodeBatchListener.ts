import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import plimit from 'p-limit';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { EventEntity, EventService } from '@ci/domains/memory';
import { GeocodeBatchRequestEvent, type GeocodeBatchRequestPayload } from '@ci/domains/memory/events';

import { GeocodeService, RETRYABLE_STATUSES, VIRTUAL_STATUS } from '../services/GeocodeService';

/** Dedicated PGBoss queue so geocode backfills don't block the default queue. */
const GEOCODE_QUEUE = 'geocode';

/**
 * Concurrency cap on in-flight Google calls. Well under Google's 25 QPS so a
 * burst of cache-miss events can't trip OVER_QUERY_LIMIT.
 */
const MAX_CONCURRENCY = 10;

/** Default batch size when the request omits `limit`. */
const DEFAULT_LIMIT = 200;

/** Exponential-backoff schedule (ms) for transient provider failures. */
const BACKOFF_MS = [500, 1500, 4000];

interface CandidateRow {
  event_id: string;
  location_name: string;
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
  private readonly limiter = plimit(MAX_CONCURRENCY);

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
    const { userId, eventIds, limit, retryNull } = payload;
    const context: UserServiceContext = { userId };

    const candidates = await this.selectCandidates(userId, {
      eventIds,
      limit: limit ?? DEFAULT_LIMIT,
      retryNull: retryNull ?? false,
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
          const outcome = await this.geocodeWithRetry(candidate.location_name);

          if (outcome.status === 'OK' && outcome.point && outcome.confidence !== null) {
            await this.eventService.update(context, candidate.event_id, {
              location_coordinates: outcome.point,
              // Inferred / coarse coords carry < 1.0 so HBPE/RAG don't treat
              // them as ground truth.
              confidence_score: outcome.confidence,
            });
            resolved++;

            return;
          }

          if (outcome.status === VIRTUAL_STATUS) {
            // Non-physical venue: record provenance so it's not retried, but
            // never write coordinates.
            await this.tagVirtual(context, candidate.event_id);
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
   * retryable statuses (and successes) return immediately.
   */
  private async geocodeWithRetry(location: string) {
    let outcome = await this.geocodeService.geocode(location);

    for (let attempt = 0; outcome.retryable && attempt < BACKOFF_MS.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
      outcome = await this.geocodeService.geocode(location);
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
   * Select the backfill candidate set: events for this user that have a
   * non-empty location_name. By default only those with NULL coordinates; with
   * retryNull the same set is re-attempted (a previously failed lookup may now
   * resolve, e.g. after a key change). An explicit eventIds list overrides the
   * auto-selection but is still scoped to the user.
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
      // Auto-selection: only events still missing coordinates. `retryNull` is
      // accepted for symmetry with the payload but resolves to the same NULL
      // filter — a non-null coordinate is never re-billed once resolved.
      query.andWhere('event.location_coordinates IS NULL');
    }

    query.orderBy('event.start_time', 'DESC').limit(opts.limit);

    return query.getRawMany<CandidateRow>();
  }

  /** Record location_source='virtual' in metadata without touching coordinates. */
  private async tagVirtual(context: UserServiceContext, eventId: string): Promise<void> {
    const event = await this.eventService.findById(context, eventId);
    if (!event) {
      return;
    }

    await this.eventService.update(context, eventId, {
      metadata: { ...event.metadata, location_source: 'virtual' },
    });
  }
}
