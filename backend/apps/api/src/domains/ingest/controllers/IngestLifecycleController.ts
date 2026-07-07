import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import {
  MaintenanceOrchestratorService,
  type OrchestrateSummary,
  SearchIndexBackfillService,
  type SearchIndexBackfillResult,
} from '@ci/domains/maintenance';

import { type IngestStatusSnapshot, IngestStatusService } from '../services/IngestStatusService';
import { type IngestFinishRequest, ingestFinishSchema } from '../types';

/**
 * Bulk-ingest lifecycle for the `/v1` machine-ingest plane. The bulk endpoints
 * (POST /v1/{events,communications,contents,inventory,browser-activity,
 * positions}) all defer indexing — no per-row *CreatedEvent fan-out — so a bulk
 * load is a three-step conversation a client can hold entirely on `/v1/*`,
 * never needing the operator-facing `/api/maintenance/*` paths:
 *
 *   1. POST the batches;
 *   2. POST /v1/ingest/finish — run the post-load enrichment + embed backfill
 *      (the full MaintenanceOrchestratorService chain, a stage subset, or just
 *      the search-index sweep with `searchIndexOnly`);
 *   3. poll GET /v1/ingest/status until the search-index queue drains.
 *
 * `finish` is synchronous-JSON only (no NDJSON streaming) — a streaming client
 * can use POST /api/maintenance/orchestrate?stream=1, which this delegates to
 * the same service. One orchestration per user at a time: a second `finish`
 * while one runs is a 409 (thrown by the orchestrator itself).
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Controller('v1/ingest')
export class IngestLifecycleController {
  constructor(
    private readonly maintenanceOrchestratorService: MaintenanceOrchestratorService,
    private readonly searchIndexBackfillService: SearchIndexBackfillService,
    private readonly ingestStatusService: IngestStatusService,
  ) {}

  @Post('finish')
  async finish(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(ingestFinishSchema)) body: IngestFinishRequest,
  ): Promise<OrchestrateSummary | SearchIndexBackfillResult> {
    const serviceContext = toServiceContext(context);

    // Cheap path: just the search-index embed backfill sweep, bypassing the
    // orchestrator — same call POST /api/maintenance/search-index/backfill
    // makes. `entityTypes` scopes the sweep to the types the bulk load touched
    // (#1671); omitted, it sweeps every backfillable type uncapped.
    if (body.searchIndexOnly === true) {
      return this.searchIndexBackfillService.backfill({ entityTypes: body.entityTypes });
    }

    // Full (or stage-subset) enrichment chain, canonical order — same call
    // POST /api/maintenance/orchestrate makes. Defaults to ALL stages.
    return this.maintenanceOrchestratorService.orchestrate(serviceContext.userId, {
      stages: body.stages,
    });
  }

  @Get('status')
  async status(): Promise<IngestStatusSnapshot> {
    return this.ingestStatusService.snapshot();
  }
}
