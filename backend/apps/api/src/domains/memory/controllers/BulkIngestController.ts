import type { IncomingMessage } from 'node:http';

import { BadRequestException, Controller, Post, Req, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { CommunicationCreatedEvent, EventCreatedEvent } from '../events';
import { type BulkEventEmitter, BulkIngestService } from '../services/BulkIngestService';
import { communicationsBulkSpec, eventsBulkSpec } from '../services/bulkTableSpecs';
import type { BulkIngestResponse } from '../types/bulkIngest';

const communicationEmitter: BulkEventEmitter<typeof CommunicationCreatedEvent> = {
  event: CommunicationCreatedEvent,
  payload: (id) => ({ communicationId: id }),
};

const eventEmitter: BulkEventEmitter<typeof EventCreatedEvent> = {
  event: EventCreatedEvent,
  payload: (id) => ({ eventId: id }),
};

/**
 * High-throughput bulk ingest (issue #11) — the COPY-backed sibling of the
 * GraphQL batch mutations (createCommunications / createEvents). The importer
 * streams an NDJSON body (one record per line); the request is NOT buffered
 * (BodyParserMiddleware's json parser ignores `application/x-ndjson`), so the
 * payload is bounded by time, not the 100kb JSON body limit that 413'd before.
 *
 * Pipeline per request: stream NDJSON → COPY into a per-request TEMP staging
 * table → set-based `INSERT … SELECT … ON CONFLICT (<provenance triple>)
 * DO NOTHING RETURNING id` → emit one `<Entity>CreatedEvent` per new row.
 * Idempotency and search indexing are identical to the per-row path; see
 * BulkIngestService. This is a tested vertical slice (communications + events);
 * inventory / browser_activity are a BulkTableSpec away (see bulkTableSpecs.ts).
 *
 * Auth reuses {@link JwtOrApiKeyAuthGuard}, the same guard the unified capture
 * ingest (/v1/events) and operator maintenance routes use.
 *
 * Contract:
 *   POST /v1/bulk/communications   Content-Type: application/x-ndjson
 *   POST /v1/bulk/events           Content-Type: application/x-ndjson
 *   Authorization: ApiKey <key>   (or Bearer <jwt>)
 *   Body: one JSON object per line; shapes in types/bulkIngest.ts.
 *   200: { received, inserted, deduped, rejected: [{ line, reason }] }
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Controller('v1/bulk')
export class BulkIngestController {
  constructor(private readonly bulkIngestService: BulkIngestService) {}

  @Post('communications')
  async ingestCommunications(
    @Context() context: RequestContext,
    @Req() request: IncomingMessage,
  ): Promise<BulkIngestResponse> {
    return this.bulkIngestService.ingest(
      this.requireUserId(context),
      request,
      communicationsBulkSpec,
      communicationEmitter,
    );
  }

  @Post('events')
  async ingestEvents(
    @Context() context: RequestContext,
    @Req() request: IncomingMessage,
  ): Promise<BulkIngestResponse> {
    return this.bulkIngestService.ingest(this.requireUserId(context), request, eventsBulkSpec, eventEmitter);
  }

  private requireUserId(context: RequestContext): string {
    const { userId } = toServiceContext(context);

    if (typeof userId !== 'string') {
      throw new BadRequestException('Bulk ingest requires an authenticated user');
    }

    return userId;
  }
}
