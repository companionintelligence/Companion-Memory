import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { OnEvent } from '@ci/domains/events';

import {
  DEAD_LETTER_QUEUE,
  DEAD_LETTER_REAP_BATCH,
  DEAD_LETTER_REAP_CRON,
  PIPELINE_CONTROL_QUEUE,
} from '../constants';
import { PipelineDeadLetterReapEvent } from '../events';
import { pipelineDeadLetterReapPayloadSchema } from '../types';

/**
 * Finally consumes pg-boss's dead-letter queue.
 *
 * ── What was happening before ──────────────────────────────────────────────
 *
 * Every work queue is created with `deadLetter: 'dead-letter'`, so a job that
 * exhausts its three retries is re-inserted onto that queue with its payload
 * and failure output preserved. **Nothing has ever read it.** The queue's own
 * comment in `PGBossEventService` says so: "Nothing works this queue, so
 * entries accumulate; it carries a long retention." There is no list endpoint,
 * no UI and no replay path, so the rows sit until pg-boss's retention deletes
 * them and the failure — along with the only surviving copy of whatever the
 * payload described — is gone.
 *
 * ── Why this polls instead of subscribing ──────────────────────────────────
 *
 * The obvious implementation is `@OnEvent(SomeEvent, { queue: 'dead-letter' })`.
 * It is a trap, and it would make things strictly worse. Dispatch on a queue is
 * by the ORIGINAL event name: `PGBossEventService.executeJob` emits
 * `${job.data.name}:${queue}`, and `EventEmitterModule.forRoot()` runs without
 * wildcards, so a handler can only ever match the one event name it was
 * registered for. But registering ANY handler on `dead-letter` makes it a
 * discovered queue, which starts a worker on it — and that worker fetches every
 * dead letter, finds no handler for the other forty event names, calls `skip()`
 * and then `boss.complete()`. Subscribing to one event on the dead-letter queue
 * would therefore silently destroy the dead letters of every other event.
 *
 * Polling `pgboss.job` avoids that entirely and is better on its own merits:
 *
 *  - it captures EVERY event name, not the ones somebody remembered to register;
 *  - it captures `job.output`, which carries the actual error and stack. The
 *    dispatch path cannot: `executeJob` hands the listener `job.data` only, so a
 *    subscribing reaper would record a failure with no failure in it;
 *  - it never completes or deletes anything, so pg-boss's own copy stays
 *    inspectable for its full retention alongside ours.
 *
 * ── Exactly-once, without a schema change ──────────────────────────────────
 *
 * `ci.pipeline_dead_letters.id` is set to the ORIGINATING pg-boss job id rather
 * than a fresh uuid. Both are uuids, the pg-boss id is unique, and it gives the
 * copy a natural idempotency key: the anti-join skips rows already copied, and
 * `ON CONFLICT (id) DO NOTHING` closes the race between two concurrent reaps.
 * It also means an operator can correlate a dead letter straight back to
 * `pgboss.job` while that row still exists.
 */
@Injectable()
export class DeadLetterReaperListener {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DeadLetterReaperListener.name);
  }

  /**
   * Scheduled reap. Off the top of the minute on purpose — three other crons
   * already fire at second 0.
   */
  @Cron(DEAD_LETTER_REAP_CRON)
  async reapOnSchedule(): Promise<void> {
    // Nothing awaits a @Cron method, so a rejection here is an unhandled promise
    // rejection — which this process treats as fatal. On a timer that means a
    // crash loop rather than a single failure, and the reaper is the one
    // component whose whole job is to be running when something else is broken.
    // Swallow-and-log is right here: the next tick retries in two minutes, and
    // an un-harvested dead letter is still sitting safely in pgboss.job.
    try {
      await this.reap();
    } catch (err: unknown) {
      this.logger.error(
        'Scheduled dead-letter reap failed; will retry on the next tick',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * On-demand reap, so an operator (or a test) can force a harvest and read the
   * table immediately instead of waiting out the cron interval.
   */
  @OnEvent(PipelineDeadLetterReapEvent, { queue: PIPELINE_CONTROL_QUEUE })
  async reapOnRequest(payload: unknown): Promise<void> {
    const { limit } = pipelineDeadLetterReapPayloadSchema.parse(payload ?? {});

    await this.reap(limit);
  }

  /**
   * Copy up to `limit` un-harvested dead letters into `ci.pipeline_dead_letters`.
   *
   * Returns the number of rows copied. Safe to run concurrently with itself and
   * safe to run forever: a healthy appliance's dead-letter partition is empty,
   * so the steady-state cost is one anti-join that returns nothing.
   */
  async reap(limit: number = DEAD_LETTER_REAP_BATCH): Promise<number> {
    // BOTH tables have to exist, and each is absent for a different reason.
    // `pgboss.job` is created by pg-boss at boot rather than by a migration, so
    // it is missing in any process using LocalEventService (tests, some dev
    // setups). `ci.pipeline_dead_letters` IS created by a migration, so it is
    // missing on a node that started before `migrate-database` finished — which
    // is every existing appliance until this branch's migration lands.
    //
    // Guarding only the source was the bug: the check passed, the INSERT raised
    // `relation "ci.pipeline_dead_letters" does not exist`, and on a two-minute
    // cron that is a crash loop rather than a single logged failure.
    const [{ exists }] = await this.dataSource.query<Array<{ exists: boolean }>>(
      `SELECT to_regclass('pgboss.job') IS NOT NULL
          AND to_regclass('ci.pipeline_dead_letters') IS NOT NULL AS exists`,
    );

    if (!exists) {
      this.logger.debug('pgboss.job or ci.pipeline_dead_letters does not exist; skipping dead-letter reap');

      return 0;
    }

    // One statement: select the un-copied dead letters and insert them.
    //
    // `j.name = $1` prunes to the dead-letter partition (pgboss.job is
    // partitioned BY LIST (name)), and the NOT EXISTS is an anti-join against
    // this table's primary key, so the steady-state cost of a reap that finds
    // nothing is an index probe per candidate.
    //
    // Column-by-column notes, each guarding a way this can meet data it did not
    // expect:
    //  - `payload` is `j.data` VERBATIM. Never wrapped, never enriched — a dead
    //    letter that cannot be replayed byte-for-byte is just a log line.
    //    COALESCEd to '{}' because the column is NOT NULL and a job may carry
    //    no data at all.
    //  - `event_name` reads `data->>'name'`, the name `send()` stamps into every
    //    payload. Jobs inserted by something other than EventService have none;
    //    they are recorded as 'unknown' rather than skipped, because an
    //    unattributable failure is still a failure.
    //  - `entity_id` is cast only when the value actually looks like a uuid. An
    //    unconditional `::uuid` would abort the whole batch over one malformed
    //    payload — and the malformed payloads are the ones most worth keeping.
    //  - `error` prefers the structured message written by
    //    `PGBossEventService.work`'s `boss.fail(...)` and appends its stack,
    //    falling back to the raw output.
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO ci.pipeline_dead_letters
              (id, queue, event_name, stage, entity_type, entity_id, user_id, payload, error, failed_at)
       SELECT j.id,
              j.name,
              COALESCE(NULLIF(j.data->>'name', ''), 'unknown'),
              j.data->>'stage',
              j.data->>'entityType',
              CASE
                WHEN j.data->>'entityId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (j.data->>'entityId')::uuid
              END,
              -- Same defensive cast as entityId, same reason: an erasure sweep
              -- that finds this row matters more than a strict parse, and one
              -- malformed payload must not abort the batch. NULL here means
              -- "not attributable to a user", which is legitimate for
              -- maintenance and telemetry jobs.
              CASE
                WHEN j.data->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (j.data->>'userId')::uuid
              END,
              COALESCE(j.data, '{}'::jsonb),
              COALESCE(
                NULLIF(j.output->>'message', '') || COALESCE(E'\\n' || (j.output->>'stack'), ''),
                j.output::text,
                'pg-boss job exhausted its retries with no recorded output'
              ),
              j.created_on
         FROM pgboss.job j
        WHERE j.name = $1
          AND NOT EXISTS (SELECT 1 FROM ci.pipeline_dead_letters d WHERE d.id = j.id)
        ORDER BY j.created_on
        LIMIT $2
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [DEAD_LETTER_QUEUE, limit],
    );

    if (rows.length > 0) {
      // Warn, not log: reaching this line means jobs died terminally. The count
      // is the signal — a steady trickle is a broken integration, a spike is an
      // outage, and both were previously invisible.
      this.logger.warn(`Harvested ${rows.length} dead letter(s) into ci.pipeline_dead_letters`, {
        queue: DEAD_LETTER_QUEUE,
        harvested: rows.length,
        // A full batch means there is more waiting; the next tick takes it.
        moreLikely: rows.length === limit,
      });
    }

    return rows.length;
  }
}
