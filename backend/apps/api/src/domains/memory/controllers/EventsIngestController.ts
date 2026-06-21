import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { EventService } from '../services/EventService';
import {
  type IngestEventsRequest,
  type IngestEventsResponse,
  ingestEventsSchema,
} from '../types/captureEvent';

// G1 unified capture ingest — the single HTTP surface every capture source writes
// through (event-ingest-spec). Three layers, in order: append-only raw log
// (ci.capture_events, idempotent on the source key) → materialized EventEntity
// (idempotent EventService.create) → the existing EventCreatedEvent enrichment
// bus. Re-POSTing the same (source_system, source_id) returns `duplicate +1`, not
// an error.
@Controller('v1/events')
export class EventsIngestController {
  constructor(
    private readonly eventService: EventService,
    private readonly dataSource: DataSource,
  ) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post()
  async ingest(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(ingestEventsSchema)) body: IngestEventsRequest,
  ): Promise<IngestEventsResponse> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    let ingested = 0;
    let duplicate = 0;
    const rejected: { index: number; reason: string }[] = [];

    for (let i = 0; i < body.events.length; i++) {
      const e = body.events[i];
      try {
        // Layer 1: append to the raw log, idempotent on the source key. RETURNING
        // is empty when the row already existed → a duplicate capture, skip it.
        const inserted: { capture_event_id: string }[] = await this.dataSource.query(
          `INSERT INTO ci.capture_events
             (user_id, source_system, source_id, kind, occurred_at, observed_at, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, source_system, source_id) DO NOTHING
           RETURNING capture_event_id`,
          [userId, e.source_system, e.source_id, e.kind, e.occurred_at, e.observed_at ?? null, e.payload],
        );

        if (inserted.length === 0) {
          duplicate++;
          continue;
        }

        // Layer 2: materialize the event (idempotent on the same source triple).
        const [event] = await this.eventService.create(serviceContext, {
          title: e.title ?? e.kind,
          description: e.description,
          start_time: new Date(e.occurred_at),
          event_type: e.kind,
          source_type: 'capture',
          source_system: e.source_system,
          source_id: e.source_id,
          confidence_score: e.confidence_score,
          metadata: { kind: e.kind, ...e.payload },
        });

        await this.dataSource.query(
          `UPDATE ci.capture_events SET event_id = $1 WHERE capture_event_id = $2`,
          [event.id, inserted[0].capture_event_id],
        );

        ingested++;
      } catch (err) {
        rejected.push({ index: i, reason: (err as Error).message });
      }
    }

    return { ingested, duplicate, rejected };
  }
}
