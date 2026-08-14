/**
 * REST bulk-ingest plane (`/v1/*`). Hosts the G1 unified capture ingest
 * (POST /v1/events) and the batch ingest endpoints for every bulk kind —
 * communications, contents, inventory, browser-activity, positions, notes
 * (batch file upload lives on the files domain's BulkFilesController at
 * POST /v1/files) —
 * plus the bulk lifecycle pair POST /v1/ingest/finish + GET /v1/ingest/status,
 * so a machine client can run a complete load → enrich → drain cycle over
 * plain REST.
 *
 * Each bulk route speaks two encodings: `application/x-ndjson` (the default
 * bulk contract — one record per line, streamed and flushed in batches; see
 * ./ndjson.ts) and the `{ records: [...] }` JSON envelope (max 10,000
 * records). Events are JSON-envelope only (`{ events: [...] }`, max 1,000).
 *
 * The bulk routes own no persistence: each delegates to the existing
 * chunk-safe, provenance-deduped bulk service exported by its home domain, and
 * the lifecycle endpoints delegate to the maintenance domain's orchestrator /
 * search-index backfill. The events route additionally appends to the
 * ci.capture_events raw log before materializing via the memory domain's
 * EventService. See BulkIngestController and IngestLifecycleController for the
 * contract.
 *
 * @module IngestModule
 */

import { Module } from '@nestjs/common';

import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { MaintenanceModule } from '@ci/domains/maintenance';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { PositionModule } from '@ci/domains/position';

import { BulkIngestController } from './controllers/BulkIngestController';
import { IngestLifecycleController } from './controllers/IngestLifecycleController';
import { IngestStatusService } from './services/IngestStatusService';

/**
 * @internal
 */
@Module({
  imports: [MemoryModule, BrowserActivityModule, PositionModule, MaintenanceModule, NotesModule],
  controllers: [BulkIngestController, IngestLifecycleController],
  providers: [IngestStatusService],
})
export class IngestModule {}

export { BulkIngestController } from './controllers/BulkIngestController';
export { IngestLifecycleController } from './controllers/IngestLifecycleController';
export { IngestStatusService, type IngestStatusSnapshot } from './services/IngestStatusService';
export type { BulkIngestResponse, IngestFinishRequest } from './types';
export {
  NDJSON_CONTENT_TYPE,
  NDJSON_BATCH_SIZE,
  NDJSON_MAX_LINE_LENGTH,
  ingestNdjsonStream,
  isNdjsonRequest,
} from './ndjson';
export type { NdjsonIngestResponse } from './ndjson';
