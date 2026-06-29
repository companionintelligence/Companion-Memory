import { Body, Controller, Get, Headers, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { MediaDimensionsBackfillRequestEvent, MEDIA_DIMENSIONS_QUEUE } from '@ci/domains/files';
import { EventEntity } from '@ci/domains/memory';
import { EstimateLocationBatchRequestEvent, GeocodeBatchRequestEvent } from '@ci/domains/memory/events';
import {
  EmbeddingEntity,
  type OrphanCleanupResult,
  OrphanCleanupService,
  type TruncateSearchIndexResult,
} from '@ci/domains/search-ingress';
import { INDEXABLE_ENTITIES, type IndexableEntity } from '@ci/domains/search-next';

import { ESTIMATE_LOCATION_QUEUE } from '../listeners/EstimateLocationBatchListener';
import {
  type CommunicationLinkBackfillProgress,
  type CommunicationLinkBackfillResult,
  CommunicationLinkBackfillService,
} from '../services/CommunicationLinkBackfillService';
import {
  type GraphEnrichmentProgressCounts,
  type GraphEnrichmentResult,
  GraphEnrichmentService,
} from '../services/GraphEnrichmentService';
import {
  type DeferralResult,
  type DroppedIndex,
  IndexDeferralService,
  type RecreateResult,
} from '../services/IndexDeferralService';
import {
  DEFAULT_ESTIMATE_SOURCE_SYSTEMS,
  DEFAULT_MAX_GAP_HOURS,
  LocationEstimateService,
} from '../services/LocationEstimateService';
import {
  BACKFILLABLE_ENTITIES,
  type SearchIndexBackfillResult,
  SearchIndexBackfillService,
} from '../services/SearchIndexBackfillService';

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
  /** Max events to geocode in this batch (default: config.geocoding.batchSize). */
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  /**
   * Re-attempt NULL-coordinate events INCLUDING ones a prior run tagged virtual
   * or negative-cached, busting the geocode cache so the provider is re-queried.
   * Use after a key change or a denylist/heuristic fix. Default false: skip
   * already-virtual rows and serve negative results from cache.
   */
  retryNull: z.boolean().optional(),
});

const estimateLocationsSchema = z.object({
  /** Max coordinate-less events to fill in this batch (default 500). */
  limit: z.coerce.number().int().min(1).max(20000).optional(),
  /**
   * Max time gap (hours) between a candidate event and its donor location; a
   * candidate with no real location within this window is left unestimated.
   * Default 24 (the "Balanced" scope).
   */
  maxGapHours: z.coerce.number().positive().max(720).optional(),
  /**
   * Restrict candidates to these source_systems (physical-presence events).
   * Defaults to the built-in allowlist (calendar/photos/purchases/transport/
   * fitness) so messages/social posts are never estimated.
   */
  sourceSystems: z.array(z.string().min(1)).min(1).optional(),
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

// Body for POST /api/maintenance/search-index/backfill. All optional: defaults
// sweep every backfillable ingest type with no per-type cap. Re-emits each
// un-indexed row's create event onto the search-index queue only.
const searchIndexBackfillSchema = z.object({
  /** Restrict the sweep to these entity types (default: all backfillable types). */
  entityTypes: z.array(z.enum(BACKFILLABLE_ENTITIES)).min(1).optional(),
  /** Source rows scanned + re-emitted per page (default 1000). */
  batchSize: z.coerce.number().int().min(1).max(50000).optional(),
  /** Hard cap on rows re-emitted PER entity type (default: unbounded). */
  limitPerType: z.coerce.number().int().min(1).optional(),
});

type SearchIndexBackfillRequest = z.infer<typeof searchIndexBackfillSchema>;

// Body for POST /api/maintenance/backfill-media-dimensions. All optional: caps
// how many ORIGINAL image/video files this batch records width/height for.
const backfillMediaDimensionsSchema = z.object({
  /** Max files to probe + record in this batch (default: MEDIA_DIMENSIONS_DEFAULT_LIMIT). */
  limit: z.coerce.number().int().min(1).max(50000).optional(),
});

type BackfillMediaDimensionsRequest = z.infer<typeof backfillMediaDimensionsSchema>;

/** Backfillable types, as a Set, for lenient `?types=` filtering. */
const BACKFILLABLE_ENTITY_SET: ReadonlySet<string> = new Set(BACKFILLABLE_ENTITIES);

// Query for GET /api/maintenance/search-index/embedded-count. `types` is an
// optional CSV of BACKFILLABLE_ENTITIES (e.g. "communication,event"). Unknown
// tokens are dropped silently rather than 400'd: the importer's drain poller
// treats any non-200 as "endpoint unavailable" and abandons the animation, so a
// stray type must not break the count. Absent (or all-unknown) => count every type.
const embeddedCountQuerySchema = z.object({
  types: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : value
            .split(',')
            .map((type) => type.trim())
            .filter((type) => BACKFILLABLE_ENTITY_SET.has(type)),
    ),
});

type EmbeddedCountQuery = z.infer<typeof embeddedCountQuerySchema>;

interface EmbeddedCountResponse {
  /** Total `ci_search.embeddings` rows matching the (optional) type filter. */
  count: number;
  /** Per-`entity_type` row counts (only the matched types appear). */
  perType: Record<string, number>;
}

type GeocodeLocationsRequest = z.infer<typeof geocodeLocationsSchema>;

type EstimateLocationsRequest = z.infer<typeof estimateLocationsSchema>;

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

// Body for POST /api/maintenance/extract-graph. All optional: caps how much of
// the user's own data the LLM extraction samples per run. Re-runnable.
const extractGraphSchema = z.object({
  /** Max communications to sample (default 200). */
  maxCommunications: z.coerce.number().int().min(0).max(5000).optional(),
  /** Max events to sample (default 100). */
  maxEvents: z.coerce.number().int().min(0).max(5000).optional(),
  /** Override the Ollama model (default: the background PROMPT_MODEL). */
  model: z.string().min(1).optional(),
});

type ExtractGraphRequest = z.infer<typeof extractGraphSchema>;

interface GeocodeLocationsResponse {
  jobId: string | null;
  estimatedEventCount: number;
  status: 'enqueued' | 'noop';
}

interface BackfillMediaDimensionsResponse {
  jobId: string | null;
  estimatedFileCount: number;
  status: 'enqueued' | 'noop';
}

/** The dedicated PGBoss queue the geocode listener consumes. */
const GEOCODE_QUEUE = 'geocode';

/** Default batch size for the location estimator when the body omits a limit. */
const ESTIMATE_DEFAULT_LIMIT = 500;

/** Default batch size for the media-dimensions backfill when the body omits a limit. */
const MEDIA_DIMENSIONS_DEFAULT_LIMIT = 500;

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
    private readonly graphEnrichmentService: GraphEnrichmentService,
    private readonly searchIndexBackfillService: SearchIndexBackfillService,
    private readonly locationEstimateService: LocationEstimateService,
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

    // Default batch size follows config.geocoding.batchSize (env GEOCODING_BATCH_SIZE).
    const limit = body.limit ?? config.geocoding.batchSize;
    const retryNull = body.retryNull ?? false;

    // Estimate how many events this batch will touch, capped at the batch limit.
    // Mirror the listener's candidate filter: by default skip rows already
    // tagged virtual; with retryNull they are re-attempted and counted.
    const countQuery = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId })
      .andWhere('event.location_name IS NOT NULL')
      .andWhere("btrim(event.location_name) <> ''")
      .andWhere('event.location_coordinates IS NULL');

    if (!retryNull) {
      countQuery.andWhere("COALESCE(event.metadata->>'location_source', '') <> 'virtual'");
    }

    const candidateCount = await countQuery.getCount();

    const estimatedEventCount = Math.min(candidateCount, limit);

    if (estimatedEventCount === 0) {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const jobIds = await this.signallingEventService.send(
      GeocodeBatchRequestEvent,
      { userId, limit, retryNull },
      { queue: GEOCODE_QUEUE },
    );

    return {
      jobId: jobIds[0] ?? null,
      estimatedEventCount,
      status: jobIds.length > 0 ? 'enqueued' : 'noop',
    };
  }

  /**
   * Reverse-geocode backfill (geodata-plan Phase 2): the inverse of
   * geocode-locations. Counts events that HAVE coordinates (photo EXIF / GPS /
   * estimation) but no readable location_name, and emits a
   * {@link GeocodeBatchRequestEvent} with direction 'reverse' so the batch
   * listener resolves a place name for each — turning bare map pins into labels.
   */
  @Post('reverse-geocode-locations')
  async reverseGeocodeLocations(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(geocodeLocationsSchema)) body: GeocodeLocationsRequest,
  ): Promise<GeocodeLocationsResponse> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const limit = body.limit ?? config.geocoding.batchSize;
    const retryNull = body.retryNull ?? false;

    // Candidate set: coordinates present, name missing — the inverse of the
    // forward backfill's filter.
    const candidateCount = await this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId })
      .andWhere('event.location_coordinates IS NOT NULL')
      .andWhere("(event.location_name IS NULL OR btrim(event.location_name) = '')")
      .getCount();

    const estimatedEventCount = Math.min(candidateCount, limit);

    if (estimatedEventCount === 0) {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const jobIds = await this.signallingEventService.send(
      GeocodeBatchRequestEvent,
      { userId, limit, retryNull, direction: 'reverse' },
      { queue: GEOCODE_QUEUE },
    );

    return {
      jobId: jobIds[0] ?? null,
      estimatedEventCount,
      status: jobIds.length > 0 ? 'enqueued' : 'noop',
    };
  }

  /**
   * Temporal location-estimation backfill (geodata-plan Phase 3). Fills
   * location_coordinates for coordinate-less physical-presence events from the
   * nearest-in-time real location within a bounded gap (LifeScope-style), so the
   * long tail of unlocated events gets onto the map. Counts the eligible
   * candidates and emits an {@link EstimateLocationBatchRequestEvent}. Run LAST
   * in the maintenance chain (after geocoding) so it only fills what nothing else
   * could resolve. Idempotent — never overwrites real coordinates, never chains
   * an estimate off another estimate.
   */
  @Post('estimate-locations')
  async estimateLocations(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(estimateLocationsSchema)) body: EstimateLocationsRequest,
  ): Promise<GeocodeLocationsResponse> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const limit = body.limit ?? ESTIMATE_DEFAULT_LIMIT;
    const maxGapHours = body.maxGapHours ?? DEFAULT_MAX_GAP_HOURS;
    const sourceSystems = body.sourceSystems ?? [...DEFAULT_ESTIMATE_SOURCE_SYSTEMS];

    const candidateCount = await this.locationEstimateService.countCandidates(
      userId,
      sourceSystems,
      Math.round(maxGapHours * 3600),
    );
    const estimatedEventCount = Math.min(candidateCount, limit);

    if (estimatedEventCount === 0) {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const jobIds = await this.signallingEventService.send(
      EstimateLocationBatchRequestEvent,
      { userId, limit, maxGapHours, sourceSystems },
      { queue: ESTIMATE_LOCATION_QUEUE },
    );

    return {
      jobId: jobIds[0] ?? null,
      estimatedEventCount,
      status: jobIds.length > 0 ? 'enqueued' : 'noop',
    };
  }

  /**
   * Media-dimensions backfill. Records `ci.files.width`/`height` for ORIGINAL
   * image/video files that still lack them — the existing corpus, ingested
   * before the preview pass started capturing dimensions. Counts the candidates
   * (locally-stored ORIGINAL image/video files with NULL width) and emits a
   * {@link MediaDimensionsBackfillRequestEvent} for the files-domain listener to
   * process out-of-band. Once recorded, EventType.mediaWidth/mediaHeight and the
   * drawer "Dimensions" row light up with no frontend change. Idempotent +
   * resumable: re-run until estimatedFileCount is 0.
   */
  @Post('backfill-media-dimensions')
  async backfillMediaDimensions(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(backfillMediaDimensionsSchema)) body: BackfillMediaDimensionsRequest,
  ): Promise<BackfillMediaDimensionsResponse> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return { jobId: null, estimatedFileCount: 0, status: 'noop' };
    }

    const limit = body.limit ?? MEDIA_DIMENSIONS_DEFAULT_LIMIT;

    // Mirror the listener's candidate filter so the estimate matches the work.
    const rows = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::bigint AS count
         FROM ci.files
        WHERE user_id = $1
          AND variant = $2
          AND key IS NOT NULL
          AND width IS NULL
          AND (content_type LIKE 'image/%' OR content_type LIKE 'video/%')`,
      [userId, 'ORIGINAL'],
    );

    const candidateCount = Number(rows[0]?.count ?? 0);
    const estimatedFileCount = Math.min(candidateCount, limit);

    if (estimatedFileCount === 0) {
      return { jobId: null, estimatedFileCount: 0, status: 'noop' };
    }

    const jobIds = await this.signallingEventService.send(
      MediaDimensionsBackfillRequestEvent,
      { userId, limit },
      { queue: MEDIA_DIMENSIONS_QUEUE },
    );

    return {
      jobId: jobIds[0] ?? null,
      estimatedFileCount,
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
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('stream') stream?: string,
    @Headers('accept') accept?: string,
  ): Promise<CommunicationLinkBackfillResult | void> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    const empty: CommunicationLinkBackfillResult = {
      examined: 0,
      fromLinked: 0,
      toLinked: 0,
      windows: 0,
      range: null,
    };

    // Opt-in streaming (NDJSON): one {type:'progress'} line per window then a
    // final {type:'result'} line. When NOT requested, behave exactly as before:
    // a single synchronous JSON result. Same JwtOrApiKeyAuthGuard either way.
    if (wantsStream(stream, accept)) {
      return this.streamNdjson<CommunicationLinkBackfillResult>(req, res, async (emit) => {
        if (typeof userId !== 'string') {
          return empty;
        }

        return this.communicationLinkBackfillService.backfill(userId, {
          startTime: body.startTime,
          endTime: body.endTime,
          windowDays: body.windowDays,
          windowLimit: body.windowLimit,
          onProgress: (partial: CommunicationLinkBackfillProgress) => emit({ type: 'progress', ...partial }),
        });
      });
    }

    if (typeof userId !== 'string') {
      return empty;
    }

    return this.communicationLinkBackfillService.backfill(userId, {
      startTime: body.startTime,
      endTime: body.endTime,
      windowDays: body.windowDays,
      windowLimit: body.windowLimit,
    });
  }

  /**
   * Graph-LLM enrichment. Samples the signed-in user's own communications +
   * events, runs the LOCAL Ollama model over the content to extract personal
   * preferences (liked/disliked concepts) and close/family relationships, then
   * writes them into the graph via the idempotent bulkIngestGraph path:
   *   - preferences -> `Concept` nodes (properties.type set to the tool vocab) +
   *     PREFERS/DISLIKES edges from the owner's self entity;
   *   - family relations -> SPOUSE/PARENT_OF/... edges between EXISTING Person
   *     nodes (resolved by name; skipped if a person isn't already in the graph).
   * This is what makes getUserPreferences / getEntertainmentPreferences /
   * getFamilyMembers return data on imported (importer-only) graphs. Re-runnable
   * and idempotent. Operator-triggered; never auto-run.
   */
  @Post('extract-graph')
  async extractGraph(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(extractGraphSchema)) body: ExtractGraphRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('stream') stream?: string,
    @Headers('accept') accept?: string,
  ): Promise<GraphEnrichmentResult | void> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    const unauthenticated: GraphEnrichmentResult = {
      sampledRecords: 0,
      preferencesExtracted: 0,
      familyRelationsExtracted: 0,
      familyRelationsResolved: 0,
      conceptsWritten: 0,
      preferenceEdgesWritten: 0,
      familyEdgesWritten: 0,
      errors: ['extract-graph requires an authenticated user'],
    };

    // Opt-in streaming (NDJSON): one {type:'progress'} line per LLM chunk (incl.
    // failed chunks, so the bar never stalls on an Ollama error) then a final
    // {type:'result'} line. When NOT requested, the response is the existing
    // single synchronous JSON. Same JwtOrApiKeyAuthGuard either way.
    if (wantsStream(stream, accept)) {
      return this.streamNdjson<GraphEnrichmentResult>(req, res, async (emit) => {
        if (typeof userId !== 'string') {
          return unauthenticated;
        }

        return this.graphEnrichmentService.enrich(userId, {
          maxCommunications: body.maxCommunications,
          maxEvents: body.maxEvents,
          model: body.model,
          onProgress: (chunksDone: number, chunksTotal: number, partial: GraphEnrichmentProgressCounts) =>
            emit({ type: 'progress', chunksDone, chunksTotal, ...partial }),
        });
      });
    }

    if (typeof userId !== 'string') {
      return unauthenticated;
    }

    return this.graphEnrichmentService.enrich(userId, {
      maxCommunications: body.maxCommunications,
      maxEvents: body.maxEvents,
      model: body.model,
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

  /**
   * Post-load search-index BACKFILL. Bulk ingest writes directly to `ci.<table>`
   * and no longer emits a per-row `*CreatedEvent` (the per-row pgboss fan-out was
   * the dominant cost at import volume), so freshly bulk-loaded rows are not yet
   * embedded. This finds rows with no `ci_search.embeddings` entry and re-emits
   * their create event onto the `search-index` queue ONLY — the existing
   * `*SearchIndexListener` does the (idempotent) embedding + tsvector upsert and
   * the batched-Ollama buffer amortises the embed calls. Re-runnable + incremental.
   * Run it after a bulk import (and after link-communications / extract-graph).
   */
  @Post('search-index/backfill')
  async backfillSearchIndex(
    @Body(new ValidationPipe(searchIndexBackfillSchema)) body: SearchIndexBackfillRequest,
  ): Promise<SearchIndexBackfillResult> {
    return this.searchIndexBackfillService.backfill({
      entityTypes: body.entityTypes,
      batchSize: body.batchSize,
      limitPerType: body.limitPerType,
    });
  }

  /**
   * Stage-6 embed-drain gauge (import-progress redesign, plan items 21-23). The
   * /search-index/backfill sweep returns `enqueued` (rows QUEUED on the
   * `search-index` pgboss queue), but the embeds drain out-of-band as the
   * listeners run. The importer polls THIS endpoint to drive its stage-6 bar from
   * a real embedded count instead of leaving it indeterminate: it reads the total,
   * subtracts a baseline taken right after the sweep, and animates toward `enqueued`.
   *
   * Returns the number of `ci_search.embeddings` rows, optionally restricted to the
   * CSV `?types=` (BACKFILLABLE_ENTITIES vocab). The count is GLOBAL — not
   * user-scoped — to mirror the backfill it tracks (which re-emits across all
   * users' un-indexed rows). The leading column of the table's
   * `UNIQUE (entity_type, entity_id)` index is `entity_type`, so the GROUP BY (and
   * the type filter) is index-served. Best-effort by contract: the importer
   * degrades gracefully if this is absent/erroring.
   */
  @Get('search-index/embedded-count')
  async embeddedCount(
    @Query(new ValidationPipe(embeddedCountQuerySchema)) query: EmbeddedCountQuery,
  ): Promise<EmbeddedCountResponse> {
    const types = query.types && query.types.length > 0 ? query.types : undefined;

    const builder = this.dataSource
      .getRepository(EmbeddingEntity)
      .createQueryBuilder('embedding')
      .select('embedding.entityType', 'entityType')
      .addSelect('COUNT(*)', 'count')
      .groupBy('embedding.entityType');

    if (types) {
      builder.where('embedding.entityType IN (:...types)', { types });
    }

    const rows = await builder.getRawMany<{ entityType: string; count: string }>();

    const perType: Record<string, number> = {};
    let count = 0;
    for (const row of rows) {
      // COUNT(*) comes back as a bigint string from the pg driver.
      const n = Number(row.count);
      perType[row.entityType] = n;
      count += n;
    }

    return { count, perType };
  }

  /**
   * Shared NDJSON streamer for the opt-in streaming maintenance endpoints. Writes
   * one JSON line per `emit(...)` call (the per-tick {type:'progress'} frames),
   * then a final {type:'result', ...result} line, then ends the response. Runs
   * the work via `@Res({ passthrough: false })`-style manual writes; the handler
   * returns `void` so Nest does not also try to serialize a body.
   */
  private async streamNdjson<TResult extends object>(
    req: Request,
    res: Response,
    run: (emit: (line: Record<string, unknown>) => void) => Promise<TResult>,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();

    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });

    const emit = (line: Record<string, unknown>) => {
      if (clientGone || res.writableEnded) {
        return;
      }

      res.write(`${JSON.stringify(line)}\n`);
    };

    try {
      const result = await run(emit);
      emit({ type: 'result', ...result });
    } catch (err) {
      emit({ type: 'error', error: (err as Error).message });
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
}

/**
 * A request opts into NDJSON streaming via `?stream=1` (any truthy-ish value
 * except '0'/'false') OR an `Accept: application/x-ndjson` header. Anything else
 * (the default) gets the back-compat synchronous JSON response.
 */
function wantsStream(stream: string | undefined, accept: string | undefined): boolean {
  if (typeof stream === 'string' && stream !== '' && stream !== '0' && stream !== 'false') {
    return true;
  }

  return typeof accept === 'string' && accept.toLowerCase().includes('application/x-ndjson');
}
