import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { MediaDimensionsBackfillRequestEvent, MEDIA_DIMENSIONS_QUEUE } from '@ci/domains/files';
import { EventEntity } from '@ci/domains/memory';
import { EstimateLocationBatchRequestEvent, GeocodeBatchRequestEvent } from '@ci/domains/memory/events';
import { EmbeddingEntity, IndexSkipEntity } from '@ci/domains/search-ingress';

import { ESTIMATE_LOCATION_QUEUE } from '../listeners/EstimateLocationBatchListener';

import {
  type CommunicationLinkBackfillOptions,
  CommunicationLinkBackfillService,
} from './CommunicationLinkBackfillService';
import {
  type EventParticipantBackfillOptions,
  EventParticipantBackfillService,
} from './EventParticipantBackfillService';
import { type GraphEnrichmentOptions, GraphEnrichmentService } from './GraphEnrichmentService';
import {
  DEFAULT_ESTIMATE_SOURCE_SYSTEMS,
  DEFAULT_MAX_GAP_HOURS,
  LocationEstimateService,
} from './LocationEstimateService';
import { type PersonStubBackfillOptions, PersonStubBackfillService } from './PersonStubBackfillService';
import { type SearchIndexBackfillOptions, SearchIndexBackfillService } from './SearchIndexBackfillService';

/**
 * The canonical execution order of the orchestrated enrichment legs. A request
 * may name any SUBSET of these stages, but they always execute in THIS order —
 * the legs have real data dependencies (extract_people seeds the identifier
 * index link_communications/link_events resolve against; geocoding should land
 * before the estimator so it only fills what nothing else could; search_index
 * runs last so the embeds cover the enriched rows).
 */
export const ORCHESTRATE_STAGES = [
  'extract_people',
  'link_communications',
  'link_events',
  'extract_graph',
  'geocode',
  'reverse_geocode',
  'estimate_locations',
  'media_dimensions',
  'search_index',
] as const;

export type OrchestrateStage = (typeof ORCHESTRATE_STAGES)[number];

/** Per-leg option passthrough — each field forwards verbatim to its leg. */
export interface OrchestrateLegOptions {
  extractPeople?: PersonStubBackfillOptions;
  linkCommunications?: Omit<CommunicationLinkBackfillOptions, 'onProgress'>;
  linkEvents?: Omit<EventParticipantBackfillOptions, 'onProgress'>;
  extractGraph?: Omit<GraphEnrichmentOptions, 'onProgress'>;
  geocode?: { limit?: number; retryNull?: boolean };
  reverseGeocode?: { limit?: number; retryNull?: boolean };
  estimateLocations?: {
    limit?: number;
    maxGapHours?: number;
    sourceSystems?: string[];
    forced?: boolean;
  };
  mediaDimensions?: { limit?: number };
  searchIndex?: SearchIndexBackfillOptions;
}

export interface OrchestrateBody {
  /** Subset of {@link ORCHESTRATE_STAGES}; executed in canonical order. Default: all. */
  stages?: OrchestrateStage[];
  options?: OrchestrateLegOptions;
  /** Stop the chain on the first leg error (remaining legs report 'skipped'). Default false: fail-soft. */
  abortOnError?: boolean;
  /**
   * When present, after enqueuing the search_index leg poll the embedded count
   * (the same ci_search.embeddings tally the GET embedded-count endpoint reads)
   * PLUS the ci_search.index_skips count until every enqueued row has embedded
   * or been skip-marked, or the timeout elapses, emitting leg-progress
   * {enqueued, embedded, skipped} per poll. Default timeout: 10 minutes.
   */
  searchIndexDrain?: { timeoutMs?: number };
}

export type OrchestrateLegStatus = 'ok' | 'error' | 'skipped';

export interface OrchestrateLegSummary {
  leg: OrchestrateStage;
  ok: boolean;
  result?: object;
  error?: string;
  durationMs: number;
}

/** The synchronous (non-stream) response body. */
export interface OrchestrateSummary {
  ok: boolean;
  legs: OrchestrateLegSummary[];
  totalDurationMs: number;
}

/** One NDJSON line: leg-start / leg-progress / leg-result / leg-error / tick / done. */
export type OrchestrateEmit = (line: Record<string, unknown>) => void;

/** Result shape of the enqueue-and-return legs (geocode / reverse_geocode / estimate_locations). */
interface EnqueueLegResult {
  jobId: string | null;
  estimatedEventCount: number;
  status: 'enqueued' | 'noop';
}

/** The dedicated PGBoss queue the geocode listener consumes (mirrors MaintenanceController). */
const GEOCODE_QUEUE = 'geocode';

/** Default batch size for the location estimator when the options omit a limit. */
const ESTIMATE_DEFAULT_LIMIT = 500;

/** Default batch size for the media-dimensions backfill when the options omit a limit. */
const MEDIA_DIMENSIONS_DEFAULT_LIMIT = 500;

/** Default cap on the post-search_index embed-drain poll. */
const DRAIN_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One-shot enrichment orchestrator: runs the maintenance legs (the individual
 * POST /api/maintenance/* backfills) back-to-back in canonical order for one
 * user, streaming NDJSON progress when an emit callback is supplied.
 *
 * - In-process legs (extract_people, link_communications, link_events,
 *   extract_graph, search_index) call the leg service directly and forward its
 *   own onProgress emits as throttled leg-progress lines.
 * - Enqueue-and-return legs (geocode, reverse_geocode, estimate_locations,
 *   media_dimensions) mirror the matching controller endpoint: count the
 *   candidates, enqueue the batch job, and report the enqueue estimate as the
 *   leg result — the actual work drains out-of-band on its PGBoss queue.
 * - Fail-soft by default: a leg error is reported as a leg-error line and the
 *   chain continues; abortOnError stops it and reports the rest 'skipped'.
 * - A single per-run interval emits {type:'tick'} heartbeats (~10s) so proxies
 *   keep the stream alive across long silent legs.
 * - Per-user overlap guard: a second orchestrate for a user already running one
 *   throws 409 (the in-process lock releases in finally).
 */
@Injectable()
export class MaintenanceOrchestratorService {
  /** @internal Test seam — poll cadence of the search_index embed drain. */
  drainPollIntervalMs = 3_000;

  /** @internal Test seam — heartbeat cadence of the {type:'tick'} lines. */
  tickIntervalMs = 10_000;

  /** @internal Test seam — min gap between forwarded leg-progress lines per leg (~2/sec). */
  progressMinIntervalMs = 500;

  /** Users with an orchestration currently in flight (in-process overlap guard). */
  private readonly runningUsers = new Set<string>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly signallingEventService: SignallingEventService,
    private readonly logger: LoggerService,
    private readonly personStubBackfillService: PersonStubBackfillService,
    private readonly communicationLinkBackfillService: CommunicationLinkBackfillService,
    private readonly eventParticipantBackfillService: EventParticipantBackfillService,
    private readonly graphEnrichmentService: GraphEnrichmentService,
    private readonly locationEstimateService: LocationEstimateService,
    private readonly searchIndexBackfillService: SearchIndexBackfillService,
  ) {
    this.logger.setContext(MaintenanceOrchestratorService.name);
  }

  /**
   * Whether an orchestration is currently running for this user. The controller
   * checks this BEFORE committing the NDJSON stream headers so a second caller
   * gets a real 409 instead of a 200 stream carrying an error line.
   */
  isRunning(userId: string): boolean {
    return this.runningUsers.has(userId);
  }

  async orchestrate(
    userId: string,
    body: OrchestrateBody,
    emit?: OrchestrateEmit,
  ): Promise<OrchestrateSummary> {
    // Per-user overlap guard. The check+add is synchronous (no await above it),
    // so two orchestrate calls in the same process can never both pass.
    if (this.runningUsers.has(userId)) {
      throw new ConflictException({ error: 'orchestration already running' });
    }

    this.runningUsers.add(userId);

    const startedAt = Date.now();
    const emitLine: OrchestrateEmit = emit ?? (() => undefined);

    // Single heartbeat interval for the whole run (only when streaming).
    const tick = emit
      ? setInterval(() => emitLine({ type: 'tick', at: new Date().toISOString() }), this.tickIntervalMs)
      : null;
    tick?.unref?.();

    try {
      const requested = this.resolveStages(body.stages);
      const legs: OrchestrateLegSummary[] = [];
      const statuses: Partial<Record<OrchestrateStage, OrchestrateLegStatus>> = {};
      let aborted = false;

      for (const [index, leg] of requested.entries()) {
        if (aborted) {
          statuses[leg] = 'skipped';
          legs.push({ leg, ok: false, error: 'skipped', durationMs: 0 });
          continue;
        }

        emitLine({ type: 'leg-start', leg, index: index + 1, of: requested.length });
        const legStartedAt = Date.now();

        try {
          const result = await this.runLeg(leg, userId, body, this.throttledProgress(emitLine, leg));
          const durationMs = Date.now() - legStartedAt;
          statuses[leg] = 'ok';
          legs.push({ leg, ok: true, result, durationMs });
          emitLine({ type: 'leg-result', leg, ok: true, result, durationMs });
        } catch (err) {
          const durationMs = Date.now() - legStartedAt;
          const message = err instanceof Error ? err.message : String(err);
          statuses[leg] = 'error';
          legs.push({ leg, ok: false, error: message, durationMs });
          emitLine({ type: 'leg-error', leg, ok: false, error: message, durationMs });
          this.logger.error(
            `Orchestrate: leg '${leg}' failed`,
            err instanceof Error ? err : new Error(message),
          );

          if (body.abortOnError === true) {
            aborted = true;
          }
        }
      }

      const totalDurationMs = Date.now() - startedAt;
      const ok = legs.length > 0 && legs.every((entry) => entry.ok);

      emitLine({ type: 'done', ok, legs: statuses, totalDurationMs });

      return { ok, legs, totalDurationMs };
    } finally {
      if (tick) {
        clearInterval(tick);
      }

      this.runningUsers.delete(userId);
    }
  }

  /** The requested stages re-ordered to the canonical sequence (body order ignored). */
  private resolveStages(stages?: OrchestrateStage[]): OrchestrateStage[] {
    if (!stages || stages.length === 0) {
      return [...ORCHESTRATE_STAGES];
    }

    const requested = new Set(stages);

    return ORCHESTRATE_STAGES.filter((stage) => requested.has(stage));
  }

  /**
   * Wrap the stream emit as a per-leg progress forwarder throttled to at most
   * one line per {@link progressMinIntervalMs} (~2/sec) — the chatty legs emit
   * per window/page/chunk, which at import scale is far denser than any
   * consumer needs. Dropped frames are safe: counts are cumulative and the
   * terminal leg-result carries the authoritative totals.
   */
  private throttledProgress(
    emit: OrchestrateEmit,
    leg: OrchestrateStage,
  ): (counters: Record<string, unknown>) => void {
    let lastEmitAt = 0;

    return (counters) => {
      const now = Date.now();

      if (now - lastEmitAt < this.progressMinIntervalMs) {
        return;
      }

      lastEmitAt = now;
      emit({ type: 'leg-progress', leg, ...counters });
    };
  }

  private async runLeg(
    leg: OrchestrateStage,
    userId: string,
    body: OrchestrateBody,
    progress: (counters: Record<string, unknown>) => void,
  ): Promise<object> {
    const options = body.options ?? {};

    switch (leg) {
      case 'extract_people':
        return this.personStubBackfillService.backfill(userId, options.extractPeople ?? {});

      case 'link_communications':
        return this.communicationLinkBackfillService.backfill(userId, {
          ...options.linkCommunications,
          onProgress: (partial) => progress({ ...partial }),
        });

      case 'link_events':
        return this.eventParticipantBackfillService.backfill(userId, {
          ...options.linkEvents,
          onProgress: (partial) => progress({ ...partial }),
        });

      case 'extract_graph':
        return this.graphEnrichmentService.enrich(userId, {
          ...options.extractGraph,
          onProgress: (chunksDone, chunksTotal, partial) => progress({ chunksDone, chunksTotal, ...partial }),
        });

      case 'geocode':
        return this.runGeocodeLeg(userId, options.geocode ?? {}, 'forward');

      case 'reverse_geocode':
        return this.runGeocodeLeg(userId, options.reverseGeocode ?? {}, 'reverse');

      case 'estimate_locations':
        return this.runEstimateLocationsLeg(userId, options.estimateLocations ?? {});

      case 'media_dimensions':
        return this.runMediaDimensionsLeg(userId, options.mediaDimensions ?? {});

      case 'search_index':
        return this.runSearchIndexLeg(body, progress);
    }
  }

  /**
   * Enqueue-and-return geocode leg — mirrors POST /api/maintenance/
   * geocode-locations (forward) and /reverse-geocode-locations (reverse): count
   * the candidates, enqueue one {@link GeocodeBatchRequestEvent}, and report the
   * enqueue estimate. The geocoding itself drains on the geocode queue.
   */
  private async runGeocodeLeg(
    userId: string,
    opts: { limit?: number; retryNull?: boolean },
    direction: 'forward' | 'reverse',
  ): Promise<EnqueueLegResult> {
    const limit = opts.limit ?? config.geocoding.batchSize;
    const retryNull = opts.retryNull ?? false;

    const countQuery = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId });

    if (direction === 'forward') {
      // Forward: location_name present, coordinates missing.
      countQuery
        .andWhere('event.location_name IS NOT NULL')
        .andWhere("btrim(event.location_name) <> ''")
        .andWhere('event.location_coordinates IS NULL');

      if (!retryNull) {
        countQuery.andWhere("COALESCE(event.metadata->>'location_source', '') <> 'virtual'");
      }
    } else {
      // Reverse: coordinates present, name missing.
      countQuery
        .andWhere('event.location_coordinates IS NOT NULL')
        .andWhere("(event.location_name IS NULL OR btrim(event.location_name) = '')");
    }

    const estimatedEventCount = Math.min(await countQuery.getCount(), limit);

    if (estimatedEventCount === 0) {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const jobIds =
      direction === 'reverse'
        ? await this.signallingEventService.send(
            GeocodeBatchRequestEvent,
            { userId, limit, retryNull, direction: 'reverse' },
            { queue: GEOCODE_QUEUE },
          )
        : await this.signallingEventService.send(
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
   * Enqueue-and-return estimate leg — mirrors POST /api/maintenance/
   * estimate-locations: count eligible candidates via the shared exact filter,
   * enqueue one {@link EstimateLocationBatchRequestEvent}, report the estimate.
   */
  private async runEstimateLocationsLeg(
    userId: string,
    opts: { limit?: number; maxGapHours?: number; sourceSystems?: string[]; forced?: boolean },
  ): Promise<EnqueueLegResult> {
    const limit = opts.limit ?? ESTIMATE_DEFAULT_LIMIT;
    const maxGapHours = opts.maxGapHours ?? DEFAULT_MAX_GAP_HOURS;
    const sourceSystems = opts.sourceSystems ?? [...DEFAULT_ESTIMATE_SOURCE_SYSTEMS];
    const forced = opts.forced === true;

    const candidateCount = await this.locationEstimateService.countCandidates(
      userId,
      sourceSystems,
      Math.round(maxGapHours * 3600),
      forced,
    );
    const estimatedEventCount = Math.min(candidateCount, limit);

    if (estimatedEventCount === 0) {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const jobIds = await this.signallingEventService.send(
      EstimateLocationBatchRequestEvent,
      { userId, limit, maxGapHours, sourceSystems, forced },
      { queue: ESTIMATE_LOCATION_QUEUE },
    );

    return {
      jobId: jobIds[0] ?? null,
      estimatedEventCount,
      status: jobIds.length > 0 ? 'enqueued' : 'noop',
    };
  }

  /**
   * Enqueue-and-return media-dimensions leg — mirrors POST /api/maintenance/
   * backfill-media-dimensions: count ORIGINAL image/video files without a
   * recorded width, enqueue one {@link MediaDimensionsBackfillRequestEvent}.
   */
  private async runMediaDimensionsLeg(
    userId: string,
    opts: { limit?: number },
  ): Promise<{ jobId: string | null; estimatedFileCount: number; status: 'enqueued' | 'noop' }> {
    const limit = opts.limit ?? MEDIA_DIMENSIONS_DEFAULT_LIMIT;

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
   * The search_index leg: run the backfill sweep (bulk re-enqueue of un-indexed
   * rows onto the search-index queue), then — when the body opts into
   * searchIndexDrain — poll until every enqueued row was either embedded OR
   * skip-marked, or the timeout elapses, emitting leg-progress
   * {enqueued, embedded, skipped}. Both figures are DELTAS against baselines
   * taken before the sweep. Counting skips is what makes the drain terminate on
   * an exact match: the listeners intentionally decline low-value rows
   * (`ci_search.index_skips`), so an embedded-only poll never converged on
   * chatty sources — a 13k-message Discord import with 1.4k skips sat at the
   * full 10-minute timeout on every sync. The timeout remains the backstop for
   * a genuinely stalled drain (e.g. Ollama down with jobs still queued).
   */
  private async runSearchIndexLeg(
    body: OrchestrateBody,
    progress: (counters: Record<string, unknown>) => void,
  ): Promise<object> {
    const opts = body.options?.searchIndex ?? {};
    const drain = body.searchIndexDrain;

    if (!drain) {
      return this.searchIndexBackfillService.backfill(opts);
    }

    const baseline = await this.embeddedCount(opts.entityTypes);
    const skipBaseline = await this.skippedCount(opts.entityTypes);
    const result = await this.searchIndexBackfillService.backfill(opts);
    const timeoutMs = drain.timeoutMs ?? DRAIN_DEFAULT_TIMEOUT_MS;
    const drainStartedAt = Date.now();
    let embedded = 0;
    let skipped = 0;

    while (embedded + skipped < result.enqueued && Date.now() - drainStartedAt < timeoutMs) {
      await sleep(this.drainPollIntervalMs);
      embedded = Math.max((await this.embeddedCount(opts.entityTypes)) - baseline, 0);
      skipped = Math.max((await this.skippedCount(opts.entityTypes)) - skipBaseline, 0);
      progress({ enqueued: result.enqueued, embedded, skipped });
    }

    return {
      ...result,
      drain: {
        enqueued: result.enqueued,
        embedded,
        skipped,
        drained: embedded + skipped >= result.enqueued,
        waitedMs: Date.now() - drainStartedAt,
      },
    };
  }

  /**
   * Total `ci_search.embeddings` rows, optionally restricted to the swept entity
   * types — the same tally GET /api/maintenance/search-index/embedded-count
   * serves (the leading `entity_type` column of the table's unique index serves
   * the filter). Global, not user-scoped, mirroring the backfill it tracks.
   */
  private async embeddedCount(types?: readonly string[]): Promise<number> {
    const builder = this.dataSource
      .getRepository(EmbeddingEntity)
      .createQueryBuilder('embedding')
      .select('COUNT(*)', 'count');

    if (types && types.length > 0) {
      builder.where('embedding.entityType IN (:...types)', { types: [...types] });
    }

    const row = await builder.getRawOne<{ count: string }>();

    return Number(row?.count ?? 0);
  }

  /**
   * Total `ci_search.index_skips` rows, optionally restricted to the swept
   * entity types — the drain's other terminal signal: a row the listener
   * examined and intentionally did NOT embed. Same scoping semantics as
   * {@link embeddedCount}.
   */
  private async skippedCount(types?: readonly string[]): Promise<number> {
    const builder = this.dataSource
      .getRepository(IndexSkipEntity)
      .createQueryBuilder('skip')
      .select('COUNT(*)', 'count');

    if (types && types.length > 0) {
      builder.where('skip.entityType IN (:...types)', { types: [...types] });
    }

    const row = await builder.getRawOne<{ count: string }>();

    return Number(row?.count ?? 0);
  }
}
