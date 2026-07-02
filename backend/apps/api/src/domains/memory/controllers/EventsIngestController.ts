import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { EventService } from '../services/EventService';
import type { CreateEventDto } from '../types';
import {
  type IngestEventsRequest,
  type IngestEventsResponse,
  ingestEventsSchema,
} from '../types/captureEvent';

/** A capture-log row that THIS request inserted (a genuine, non-duplicate capture). */
interface InsertedCapture {
  captureEventId: string;
  /** Index of the originating event in the request batch (for `rejected` reporting). */
  index: number;
}

// G1 unified capture ingest — the single HTTP surface every capture source writes
// through (event-ingest-spec). Three layers, in order: append-only raw log
// (ci.capture_events, idempotent on the source key) -> materialized EventEntity
// (idempotent EventService.create) -> the existing EventCreatedEvent enrichment
// bus. Re-POSTing the same (source_system, source_id) returns `duplicate +1`, not
// an error.
//
// This path is set-based, not a per-row loop: one multi-row INSERT...ON CONFLICT
// into ci.capture_events per batch (the idempotency gate), one batched
// EventService.create for the genuine inserts (itself a single INSERT...ON CONFLICT
// via bulkInsertIdempotent), and one batched UPDATE to back-link event_id. This
// reuses the #1545 bulk hot-path pattern so /v1/events can sustain the importer's
// throughput target (>=150 items/s on the 854k-item replay corpus) instead of the
// old ~3-queries-per-event loop. See CI-Engineering
// architecture/subsystems/ingest-and-capture.md (P0: batch ingest).
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

    const events = body.events;
    const rejected: { index: number; reason: string }[] = [];

    // --- Layer 1: append to the raw log, set-based, idempotent on the source key.
    // One multi-row INSERT ... ON CONFLICT (user_id, source_system, source_id) DO
    // NOTHING. DO NOTHING never RETURNs a conflicting row, so every returned row is
    // a genuine insert; the rows NOT returned are duplicate captures. We map
    // returned rows back to their request index via (source_system, source_id).
    const inserted = await this.insertCaptureRows(userId, events);
    const duplicate = events.length - inserted.length;

    if (inserted.length === 0) {
      return { ingested: 0, duplicate, rejected };
    }

    // --- Layer 2: materialize the genuine inserts in one batched, idempotent
    // create (bulkInsertIdempotent under the hood: a single INSERT ... ON CONFLICT
    // on the provenance triple). Results come back in input order, so they zip 1:1
    // with `inserted`.
    const dtos: CreateEventDto[] = inserted.map(({ index }) => {
      const e = events[index];

      return {
        title: e.title ?? e.kind,
        description: e.description,
        start_time: new Date(e.occurred_at),
        event_type: e.kind,
        source_type: 'capture',
        source_system: e.source_system,
        source_id: e.source_id,
        confidence_score: e.confidence_score,
        metadata: { kind: e.kind, ...e.payload },
      };
    });

    let ingested = 0;
    try {
      const materialized = await this.eventService.create(serviceContext, dtos);

      // --- Layer 3: back-link each capture row to its event in one batched UPDATE.
      const links = inserted.map(({ captureEventId }, i) => ({
        captureEventId,
        eventId: materialized[i].id,
      }));
      await this.linkCaptureEvents(links);

      ingested = materialized.length;
    } catch (err) {
      // Materialization / back-link is set-based, so a failure fails the whole
      // batch of genuine inserts rather than a single row. Report each with its
      // originating request index (validation already ran per-row via the schema,
      // so a failure here is systemic, e.g. the DB is unreachable).
      const reason = (err as Error).message;
      for (const { index } of inserted) {
        rejected.push({ index, reason });
      }
    }

    return { ingested, duplicate, rejected };
  }

  /**
   * Set-based insert of the batch into ci.capture_events, idempotent on
   * (user_id, source_system, source_id). Returns one entry per row THIS call
   * inserted (duplicates conflict out and are not returned), carrying the new
   * capture_event_id and the row's index in the request batch.
   */
  private async insertCaptureRows(
    userId: string,
    events: IngestEventsRequest['events'],
  ): Promise<InsertedCapture[]> {
    // Collapse intra-batch duplicate (source_system, source_id) keys to their first
    // occurrence BEFORE building the INSERT. Postgres ON CONFLICT DO NOTHING dedups
    // against already-committed rows, not against a second row in the same VALUES
    // list targeting a brand-new key. Pre-collapsing keeps exactly one row per key
    // in the statement and counts the rest as duplicates, reproducing the old
    // per-row loop (the second POST of a repeated key hit the ON CONFLICT). The
    // kept row carries the FIRST occurrence's index and payload.
    const seen = new Set<string>();
    const candidates: { event: IngestEventsRequest['events'][number]; index: number }[] = [];
    events.forEach((event, index) => {
      const key = `${event.source_system} ${event.source_id}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      candidates.push({ event, index });
    });

    if (candidates.length === 0) {
      return [];
    }

    // Build a flat parameter list: 7 columns per row.
    const cols = 7;
    const valuesSql = candidates
      .map((_, i) => {
        const b = i * cols;

        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
      })
      .join(', ');

    const params: unknown[] = [];
    for (const { event } of candidates) {
      params.push(
        userId,
        event.source_system,
        event.source_id,
        event.kind,
        event.occurred_at,
        event.observed_at ?? null,
        event.payload,
      );
    }

    const rows: { capture_event_id: string; source_system: string; source_id: string }[] =
      await this.dataSource.query(
        `INSERT INTO ci.capture_events
           (user_id, source_system, source_id, kind, occurred_at, observed_at, payload)
         VALUES ${valuesSql}
         ON CONFLICT (user_id, source_system, source_id) DO NOTHING
         RETURNING capture_event_id, source_system, source_id`,
        params,
      );

    // Map each returned (genuine-insert) row back to the request index of its
    // candidate by source key. Rows NOT returned already existed for this user and
    // are duplicates. Keys are unique across candidates, so the lookup is 1:1.
    const indexBySourceKey = new Map<string, number>();
    for (const { event, index } of candidates) {
      indexBySourceKey.set(`${event.source_system} ${event.source_id}`, index);
    }

    const result: InsertedCapture[] = [];
    for (const row of rows) {
      const index = indexBySourceKey.get(`${row.source_system} ${row.source_id}`);
      if (index === undefined) {
        continue;
      }

      result.push({ captureEventId: row.capture_event_id, index });
    }

    // Keep request order so the materialization results zip 1:1 by index.
    result.sort((a, b) => a.index - b.index);

    return result;
  }

  /**
   * Batched back-link of capture rows to their materialized events. One UPDATE ...
   * FROM (unnest) statement instead of one UPDATE per row.
   */
  private async linkCaptureEvents(links: { captureEventId: string; eventId: string }[]): Promise<void> {
    if (links.length === 0) {
      return;
    }

    const captureIds = links.map((l) => l.captureEventId);
    const eventIds = links.map((l) => l.eventId);

    await this.dataSource.query(
      `UPDATE ci.capture_events AS ce
         SET event_id = data.event_id::uuid
       FROM (
         SELECT UNNEST($1::uuid[]) AS capture_event_id, UNNEST($2::uuid[]) AS event_id
       ) AS data
       WHERE ce.capture_event_id = data.capture_event_id`,
      [captureIds, eventIds],
    );
  }
}
