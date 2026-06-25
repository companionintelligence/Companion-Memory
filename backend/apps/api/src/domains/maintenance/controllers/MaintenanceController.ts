import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { EventEntity } from '@ci/domains/memory';
import { GeocodeBatchRequestEvent } from '@ci/domains/memory/events';
import {
  type OrphanCleanupResult,
  OrphanCleanupService,
  type TruncateSearchIndexResult,
} from '@ci/domains/search-ingress';
import { INDEXABLE_ENTITIES, type IndexableEntity } from '@ci/domains/search-next';

import {
  type CommunicationLinkBackfillResult,
  CommunicationLinkBackfillService,
} from '../services/CommunicationLinkBackfillService';
import { type GraphEnrichmentResult, GraphEnrichmentService } from '../services/GraphEnrichmentService';
import {
  type DeferralResult,
  type DroppedIndex,
  IndexDeferralService,
  type RecreateResult,
} from '../services/IndexDeferralService';
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
    private readonly graphEnrichmentService: GraphEnrichmentService,
    private readonly searchIndexBackfillService: SearchIndexBackfillService,
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
  ): Promise<GraphEnrichmentResult> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return {
        sampledRecords: 0,
        preferencesExtracted: 0,
        familyRelationsExtracted: 0,
        familyRelationsResolved: 0,
        conceptsWritten: 0,
        preferenceEdgesWritten: 0,
        familyEdgesWritten: 0,
        errors: ['extract-graph requires an authenticated user'],
      };
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
}
