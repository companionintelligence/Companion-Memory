import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Injectable } from '@nestjs/common';
import { from as copyFrom } from 'pg-copy-streams';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { EventService as SignallingEventService, type EventRegistry } from '@ci/domains/events';

import { type BulkIngestResponse, type BulkTableSpec } from '../types/bulkIngest';

import { buildCopyStatement, buildStagingDdl, encodeCopyRow } from './copyText';

/**
 * How a destination's per-row created event is shaped, so the bulk path can
 * fan the SAME signalling event the per-row service emits (e.g.
 * CommunicationCreatedEvent → { communicationId }) for every newly-inserted
 * row. That keeps the embedding / tsvector search pipeline indexing bulk rows.
 */
export interface BulkEventEmitter<E extends keyof EventRegistry> {
  readonly event: E;
  readonly payload: (id: string) => EventRegistry[E];
}

@Injectable()
export class BulkIngestService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly signallingEventService: SignallingEventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BulkIngestService.name);
  }

  /**
   * Stream an NDJSON body into a destination table via Postgres COPY.
   *
   * Pipeline (all on ONE pooled connection inside ONE transaction, so the TEMP
   * staging table is visible to the fold and `ON COMMIT DROP` always cleans up):
   *   1. CREATE TEMP TABLE <staging> ON COMMIT DROP
   *   2. COPY <staging> FROM STDIN  ← validated NDJSON rows, COPY-text encoded
   *   3. INSERT INTO ci.<table> SELECT … FROM <staging>
   *        ON CONFLICT (<provenance triple>) WHERE source_id IS NOT NULL DO NOTHING
   *        RETURNING <id>
   *   4. COMMIT, then emit one <Entity>CreatedEvent per RETURNED id.
   *
   * Idempotency is identical to the GraphQL path: the conflict target is the
   * destination's `*_source_triple_uniq` partial unique index, so a re-sync of
   * the same (…source triple) is a no-op (counted as `deduped`). Events are
   * emitted only for rows the INSERT actually wrote, so re-ingest does not
   * re-index. Emission happens AFTER commit so we never signal a row that
   * rolled back.
   *
   * Validation is per-line and non-fatal: a malformed line is recorded in
   * `rejected` and the rest of the stream still loads. A failure in the COPY /
   * fold itself rolls the whole request back and throws.
   */
  async ingest<T, E extends keyof EventRegistry>(
    userId: string,
    body: Readable,
    spec: BulkTableSpec<T>,
    emitter: BulkEventEmitter<E>,
  ): Promise<BulkIngestResponse> {
    const rejected: { line: number; reason: string }[] = [];
    let received = 0;

    const queryRunner = this.dataSource.createQueryRunner();
    // connect() returns the raw pg PoolClient backing this query runner —
    // pg-copy-streams needs the underlying connection to submit the COPY
    // protocol message. Subsequent queryRunner.query() calls reuse this same
    // connection, so the TEMP staging table is visible to the fold.
    const client = (await queryRunner.connect()) as {
      query: (config: unknown) => unknown;
    };

    let insertedIds: string[] = [];

    try {
      await queryRunner.startTransaction();

      await queryRunner.query(buildStagingDdl(spec.stagingTable, spec.stagingColumns));

      const copyStream = client.query(
        copyFrom(buildCopyStatement(spec.stagingTable, spec.stagingColumns)),
      ) as NodeJS.WritableStream;

      // Read the body a line at a time; validate; write COPY-text rows. Back-
      // pressure is handled by stream/promises.pipeline driving the line source
      // into the copy stream through an async generator.
      const rl = createInterface({ input: body, crlfDelay: Infinity });

      await pipeline(async function* encode() {
        for await (const rawLine of rl) {
          const line = rawLine.trim();
          if (line.length === 0) {
            continue; // tolerate blank lines / trailing newline
          }

          received++;

          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            rejected.push({ line: received, reason: 'invalid JSON' });
            continue;
          }

          const result = spec.schema.safeParse(parsed);
          if (!result.success) {
            rejected.push({ line: received, reason: result.error.issues[0]?.message ?? 'validation failed' });
            continue;
          }

          yield `${encodeCopyRow(result.data, spec.copyColumns)}\n`;
        }
      }, copyStream);

      // Fold staging → destination, deduping on the provenance triple. userId is
      // a bound parameter ($1), never interpolated.
      const inserted: Record<string, string>[] = await queryRunner.query(spec.insertSelectSql, [userId]);
      insertedIds = inserted.map((row) => row[spec.idColumn]);

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction().catch(() => undefined);
      throw err;
    } finally {
      await queryRunner.release();
    }

    // Emit the same per-row created event the single-row service emits, so the
    // search-index listeners (embedding + tsvector) pick up bulk-loaded rows.
    // Post-commit: a rolled-back row is never signalled.
    await Promise.all(
      insertedIds.map((id) => this.signallingEventService.send(emitter.event, emitter.payload(id))),
    );

    const validCount = received - rejected.length;
    const inserted = insertedIds.length;
    const deduped = Math.max(0, validCount - inserted);

    this.logger.log('Bulk ingest complete', {
      destination: spec.destination,
      received,
      inserted,
      deduped,
      rejected: rejected.length,
    });

    return { received, inserted, deduped, rejected };
  }
}
