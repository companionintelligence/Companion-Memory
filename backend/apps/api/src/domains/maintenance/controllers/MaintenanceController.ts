import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { EventEntity } from '@ci/domains/memory';
import { GeocodeBatchRequestEvent } from '@ci/domains/memory/events';
import {
  type OrphanCleanupResult,
  OrphanCleanupService,
  type TruncateSearchIndexResult,
} from '@ci/domains/search-ingress';
import {
  INDEXABLE_ENTITIES,
  type IndexableEntity,
} from '@ci/domains/search-next';

import {
  type CommunicationLinkBackfillResult,
  CommunicationLinkBackfillService,
} from '../services/CommunicationLinkBackfillService';
import {
  type DeferralResult,
  type DroppedIndex,
  IndexDeferralService,
  type RecreateResult,
} from '../services/IndexDeferralService';

// Body for POST /api/maintenance/indexes/recreate: the `dropped` array returned
// verbatim by the matching /drop call (each carries its exact CREATE statement).
const recreateIndexesSchema = z.object({
  dropped: z
    .array(
      z.object({
        schema: z.string(),
        name: z.string(),
        definition: z.string(),
      }),
    )
    .min(1),
});

const geocodeLocationsSchema = z.object({
  /** Max events to geocode in this batch. */
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  /** Re-attempt events still missing coordinates (default: same as the auto set). */
  retryNull: z.boolean().optional(),
});

// Body for POST /api/maintenance/search-index/cleanup-orphans. All optional;
// defaults sweep every indexable type and actually delete (not a dry run).
const cleanupOrphansSchema = z.object({
  /** Rows deleted per statement; bounds lock/WAL footprint. Default 5000. */
  batchSize: z.coerce.number().int().min(1).max(100000).optional(),
  /** Restrict the sweep to these entity types (default: all). */
  entityTypes: z.array(z.enum(INDEXABLE_ENTITIES)).min(1).optional(),
  /** Count orphans without deleting (sizing pass). */
  dryRun: z.boolean().optional(),
});

type CleanupOrphansRequest = z.infer<typeof cleanupOrphansSchema>;

// Body for POST /api/maintenance/search-index/truncate. Destructive — requires
// an explicit confirm so it cannot be triggered by an empty/accidental POST.
const truncateSearchIndexSchema = z.object({
  confirm: z.literal(true),
});

type GeocodeLocationsRequest = z.infer<typeof geocodeLocationsSchema>;

// Body for POST /api/maintenance/link-communications. All optional: with no
// time range the job derives the bound from the data's own MIN/MAX(time) and
// walks the whole history in windows. A range is cheaper/safer on the
// hypertable. Dates accept ISO strings (coerced to Date).
const linkCommunicationsSchema = z.object({
  /** Lower bound (inclusive) on communication `time`. */
  startTime: z.coerce.date().optional(),
  /** Upper bound (exclusive) on communication `time`. */
  endTime: z.coerce.date().optional(),
  /** Window width in days (default 7). Each window is one bounded read+update. */
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
  /** Max candidate rows examined per window (default 5000). */
  windowLimit: z.coerce.number().int().min(1).max(50000).optional(),
});

type LinkCommunicationsRequest = z.infer<typeof linkCommunicationsSchema>;

interface GeocodeLocationsResponse {
  jobId: string | null;
  estimatedEventCount: number;
  status: 'enqueued' | 'noop';
}

/** Default batch size — mirrors GeocodeBatchListener.DEFAULT_LIMIT. */
const DEFAULT_LIMIT = 200;

/** The dedicated PGBoss queue the geocode listener consumes. */
const GEOCODE_QUEUE = 'geocode';

/**
 * Operator-facing maintenance endpoints. POST /api/maintenance/geocode-locations
 * enqueues a forward-geocode backfill (geodata-plan Phase 1): it counts the
 * candidate events (location_name present, coordinates missing) and emits a
 * {@link GeocodeBatchRequestEvent} onto the geocode queue for the batch listener
 * to process out-of-band.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Controller('api/maintenance')
export class MaintenanceController {
  constructor(
    private readonly signallingEventService: SignallingEventService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly indexDeferralService: IndexDeferralService,
    private readonly orphanCleanupService: OrphanCleanupService,
    private readonly communicationLinkBackfillService: CommunicationLinkBackfillService,
  ) {}

  @Post('geocode-locations')
  async geocodeLocations(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(geocodeLocationsSchema)) body: GeocodeLocationsRequest,
  ): Promise<GeocodeLocationsResponse> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const limit = body.limit ?? DEFAULT_LIMIT;

    // Estimate how many events this batch will touch, capped at the batch limit.
    const candidateCount = await this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId })
      .andWhere('event.location_name IS NOT NULL')
      .andWhere("btrim(event.location_name) <> ''")
      .andWhere('event.location_coordinates IS NULL')
      .getCount();

    const estimatedEventCount = Math.min(candidateCount, limit);

    if (estimatedEventCount === 0) {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const jobIds = await this.signallingEventService.send(
      GeocodeBatchRequestEvent,
      { userId, limit, retryNull: body.retryNull ?? false },
      { queue: GEOCODE_QUEUE },
    );

    return {
      jobId: jobIds[0] ?? null,
      estimatedEventCount,
      status: jobIds.length > 0 ? 'enqueued' : 'noop',
    };
  }

  /**
   * People-linking backfill. Resolves communications' raw participant strings
   * (participants_metadata.from / .to) to graph entities via the normalized
   * entity_identifiers index, filling from_entity_id / to_entity_ids where they
   * are NULL. Re-runnable, idempotent (only touches NULL link columns), creates
   * no stub Person entities. Bounded per time-window so it never triggers the
   * all-chunk hypertable scan. Operator-triggered; safe to run repeatedly as new
   * identifiers arrive.
   */
  @Post('link-communications')
  async linkCommunications(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(linkCommunicationsSchema)) body: LinkCommunicationsRequest,
  ): Promise<CommunicationLinkBackfillResult> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return { examined: 0, fromLinked: 0, toLinked: 0, windows: 0, range: null };
    }

    return this.communicationLinkBackfillService.backfill(userId, {
      startTime: body.startTime,
      endTime: body.endTime,
      windowDays: body.windowDays,
      windowLimit: body.windowLimit,
    });
  }

  /**
   * Index-deferral helper (issue #12), DROP phase. Drops the deferrable
   * secondary indexes (FTS GIN, pgvector HNSW, per-table btree/GIN on the bulk
   * destinations) before a very large load. Returns each dropped index's exact
   * recreate statement in `dropped` — POST that array back to /indexes/recreate
   * after the load. Provenance unique indexes and primary keys are never
   * dropped (enforced in IndexDeferralService). OPT-IN; operator-triggered.
   */
  @Post('indexes/drop')
  async dropIndexes(): Promise<DeferralResult> {
    return this.indexDeferralService.dropDeferredIndexes();
  }

  /**
   * Index-deferral helper (issue #12), RECREATE phase. Recreates the indexes
   * dropped by /indexes/drop from the definitions returned there (passed back
   * verbatim in the body).
   */
  @Post('indexes/recreate')
  async recreateIndexes(
    @Body(new ValidationPipe(recreateIndexesSchema)) body: { dropped: DroppedIndex[] },
  ): Promise<RecreateResult> {
    return this.indexDeferralService.recreateDeferredIndexes(body.dropped);
  }

  /**
   * Search-index hygiene (#2), ORPHAN-CLEANUP phase. Deletes
   * `ci_search.embeddings` / `ci_search.vectors` rows whose `entity_id` no longer
   * exists in its source table (per the entity-source map). Re-runnable and
   * batched so it is safe online; pass `{ "dryRun": true }` to count first.
   * Complements the per-event cascade-delete the search listeners now do on
   * `*RemovedEvent` — this reaps the historical orphans those never covered.
   */
  @Post('search-index/cleanup-orphans')
  async cleanupSearchOrphans(
    @Body(new ValidationPipe(cleanupOrphansSchema)) body: CleanupOrphansRequest,
  ): Promise<OrphanCleanupResult> {
    return this.orphanCleanupService.cleanOrphans({
      batchSize: body.batchSize,
      entityTypes: body.entityTypes as IndexableEntity[] | undefined,
      dryRun: body.dryRun,
    });
  }

  /**
   * Search-index hygiene (#2), RESET phase. Truncates BOTH `ci_search` index
   * tables wholesale. A data reset that clears `ci.*` must also do this (or it
   * re-orphans the entire index). Destructive — requires `{ "confirm": true }`.
   */
  @Post('search-index/truncate')
  async truncateSearchIndex(
    @Body(new ValidationPipe(truncateSearchIndexSchema)) body: { confirm: true },
  ): Promise<TruncateSearchIndexResult> {
    // The ValidationPipe enforces the `confirm: true` guard; the value isn't otherwise used.
    void body;

    return this.orphanCleanupService.truncateSearchIndex();
  }
}
