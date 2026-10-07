import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { OnEvent } from '@ci/domains/events';

import {
  DEAD_LETTER_PURGE_BATCH,
  DEAD_LETTER_QUEUE,
  DEAD_LETTER_REAP_BATCH,
  DEAD_LETTER_REAP_CRON,
  DEAD_LETTER_REPLAYED_RETENTION_DAYS,
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
 * `ci.pipeline_dead_letters.id` is set to the pg-boss id of the dead-letter row
 * (pg-boss inserts that copy as a new job, so it is not the id of the job that
 * failed) rather than a fresh uuid. Both are uuids, the pg-boss id is unique,
 * and it gives the copy a natural idempotency key: the anti-join skips rows
 * already copied, and
 * `ON CONFLICT (id) DO NOTHING` closes the race between two concurrent reaps.
 * It also means an operator can correlate a dead letter straight back to
 * `pgboss.job` while that row still exists.
 *
 * ── Why the same class also DELETES ────────────────────────────────────────
 *
 * This is a writer with a scheduled, batched producer — {@link DEAD_LETTER_REAP_BATCH}
 * rows every two minutes, a 360k/day ceiling — pointed at a table that had no cap
 * of any kind. The reclamation therefore belongs here, on the same tick as the
 * growth, rather than in a second cron a reviewer has to correlate with this one:
 * one class, one cadence, and the bound is legible next to the thing it bounds.
 *
 * What it reclaims is deliberately narrow. {@link DeadLetterReaperListener.purgeReplayed}
 * touches ONLY letters whose `replayed_at` is non-NULL — letters an operator
 * asked back onto the bus and that `EventService.send` accepted. An UNREPLAYED
 * letter has no TTL, at any age, for the reason the table exists: its payload is
 * frequently the only surviving copy of a record the source will not re-send.
 * That promise is load-bearing, so the purge's predicate is the complement of
 * the replay path's own partial index and nothing in this file may widen it.
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
   * Scheduled reap, and the retention purge that bounds what it writes.
   *
   * Off the top of the minute on purpose — three other crons already fire at
   * second 0.
   *
   * The two legs are caught SEPARATELY, and that is the whole reason there are
   * two `try` blocks rather than one. They fail for unrelated reasons (the
   * harvest reads `pgboss.job`, the purge does not), and a single catch would
   * mean a database hiccup during the harvest silently skipped reclamation on
   * every tick from then on — an unbounded table that reports itself healthy,
   * which is the exact failure class this leg exists to remove.
   */
  // `exclusive`: the reap is safe to run concurrently with itself (the anti-join
  // and the primary key see to that) but it is not USEFUL to — a two-minute tick
  // landing on a reap that is still copying just runs the same anti-join twice.
  // Nothing here guards that, so the wrapper does.
  @Cron(DEAD_LETTER_REAP_CRON, { name: 'DeadLetterReaperListener.reapOnSchedule', exclusive: true })
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

    // Harvest first, purge second, deliberately. The harvest is time-sensitive —
    // pg-boss's own retention eventually deletes the source row — while a
    // replayed letter that survives one extra tick costs nothing.
    try {
      await this.purgeReplayed();
    } catch (err: unknown) {
      this.logger.error(
        'Scheduled dead-letter purge failed; will retry on the next tick',
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
    //  - `queue` is the queue the job FAILED on, read from `output.queue`, which
    //    `PGBossEventService` writes on both of its failure paths. pg-boss's
    //    dead-letter copy keeps `data` and `output` and drops the source queue,
    //    so this is the only place it survives. Replay sends the letter to this
    //    queue alone, unless it no longer listens for the event or the letter
    //    has a better route (see `replayQueueFor` in PipelineRunService).
    //    Before, every reaped letter said `dead-letter` and replay
    //    fanned it out to every queue listening for the event: a `file.uploaded`
    //    that failed only its preview re-ran all six of its listeners. A blank,
    //    non-string or `dead-letter` value falls back to `j.name`, as does an
    //    output with no queue (pg-boss's own expiry writes one, and so did every
    //    failure before this field existed). Those still replay by listener
    //    registration.
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
              CASE
                WHEN jsonb_typeof(j.output->'queue') = 'string'
                 AND j.output->>'queue' NOT IN ('', $1)
                THEN j.output->>'queue'
                ELSE j.name
              END,
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
              -- maintenance and telemetry jobs, and such a letter is shown to
              -- the appliance admin only.
              --
              -- ownerId is the fallback because the graph and chat events
              -- (graph.node.upserted, graph.relationship.upserted, chat.generate,
              -- chat.summarization) name their user that way. Reading userId
              -- alone filed those as NULL, and a NULL letter used to be listed
              -- and replayable for every account on the appliance. Each key is
              -- cast only when it is a uuid on its own, so a malformed userId
              -- still falls through to a good ownerId. The backfill in
              -- 20261006065131 applies the same rule to existing rows.
              COALESCE(
                CASE
                  WHEN j.data->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (j.data->>'userId')::uuid
                END,
                CASE
                  WHEN j.data->>'ownerId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (j.data->>'ownerId')::uuid
                END
              ),
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

  /**
   * Delete letters that were REPLAYED longer than `retentionDays` ago.
   *
   * Returns the number of rows deleted.
   *
   * ── What this is allowed to touch, and what it is not ──────────────────────
   *
   * `replayed_at IS NOT NULL` is the entire scope, and it is not a convenience
   * filter — it is the promise the table was created with, spelled as a
   * predicate. An unreplayed letter is never deleted here at any age: its
   * payload is often the only surviving copy of a record, nobody has asked for
   * it back yet, and a sweep that took it would destroy the evidence this whole
   * subsystem exists to keep. Whether unreplayed letters should EVER expire is a
   * product decision about acceptable data loss; it is deliberately not made in
   * code.
   *
   * Deleting a replayed letter is not the same trade. `replayed_at` is stamped
   * only when the re-emit actually succeeded — `PipelineRunService.emitClaimedLetter`
   * releases the claim on every failure path, including the silent one where
   * `send()` returns no job ids — so a stamped row is one whose payload has
   * already been handed back to the system. If the replayed job died again,
   * pg-boss dead-lettered it again and {@link DeadLetterReaperListener.reap}
   * harvested a fresh row for the new failure. What ages out is the operator's
   * record that a replay happened, not the record itself.
   *
   * ── Why it is written this way ─────────────────────────────────────────────
   *
   *  - The cutoff is computed by POSTGRES (`now() - make_interval(...)`), never
   *    in this process. `replayed_at` was written by the database clock, so the
   *    comparison has to be made against the same clock or a node with a skewed
   *    time deletes rows the operator can still see in the UI as recent.
   *  - The candidate set is chosen by a bounded `SELECT ... ORDER BY replayed_at
   *    LIMIT ... FOR UPDATE SKIP LOCKED` rather than by an open `DELETE ...
   *    WHERE`. That caps one statement's work at the moment the table is
   *    largest, takes the oldest first so a backlog drains in a defined order,
   *    and SKIP LOCKED means a concurrent replay holding a row simply keeps it
   *    for the next tick instead of blocking the sweep behind it.
   *  - The outer command is a SELECT over a CTE, not a bare `DELETE ...
   *    RETURNING`. TypeORM's Postgres driver special-cases DELETE/UPDATE and
   *    resolves `[rows, rowCount]`, so a bare RETURNING would hand back an array
   *    whose first element is the rows array — making the count wrong in a way
   *    only a live database reveals (the same trap documented on
   *    `PipelineRunService.replayDeadLetter`).
   */
  async purgeReplayed(
    retentionDays: number = DEAD_LETTER_REPLAYED_RETENTION_DAYS,
    limit: number = DEAD_LETTER_PURGE_BATCH,
  ): Promise<number> {
    // Refuse rather than obey. A zero or negative window means "delete letters
    // replayed just now", which would empty the replay history of an incident
    // in progress; a fractional or NaN one is a misconfiguration whose effect
    // nobody could predict from reading it. Both are far more likely to be a
    // mistake than an intention, and this is a DELETE.
    if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
      throw new RangeError(
        `Dead-letter retention must be a positive whole number of days; got ${String(retentionDays)}. ` +
          'Raise queues.replayedDeadLetterRetentionDays (CI_REPLAYED_DEAD_LETTER_RETENTION_DAYS) to keep ' +
          'replayed letters longer — there is no value that means "purge everything".',
      );
    }

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`Dead-letter purge batch must be a positive whole number; got ${String(limit)}.`);
    }

    // Only OUR table is needed here, unlike the harvest: this leg never reads
    // `pgboss.job`. Guarded all the same, because the table is absent on a node
    // that started before `migrate-database` finished, and on a two-minute cron
    // an unguarded `relation does not exist` is a log full of the same error.
    const [{ exists }] = await this.dataSource.query<Array<{ exists: boolean }>>(
      `SELECT to_regclass('ci.pipeline_dead_letters') IS NOT NULL AS exists`,
    );

    if (!exists) {
      this.logger.debug('ci.pipeline_dead_letters does not exist; skipping dead-letter purge');

      return 0;
    }

    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `WITH doomed AS (
         SELECT id
           FROM ci.pipeline_dead_letters
          WHERE replayed_at IS NOT NULL
            AND replayed_at < now() - make_interval(days => $1::int)
          ORDER BY replayed_at
          LIMIT $2
            FOR UPDATE SKIP LOCKED
       ), purged AS (
         DELETE FROM ci.pipeline_dead_letters d
          USING doomed
          WHERE d.id = doomed.id
       RETURNING d.id
       )
       SELECT id FROM purged`,
      [retentionDays, limit],
    );

    if (rows.length > 0) {
      // log, not warn: reclaiming a letter whose payload was already re-emitted
      // is routine housekeeping, not an incident. It is not silent either — the
      // one thing an operator must be able to reconstruct is why a letter they
      // remember replaying is no longer in the list.
      this.logger.log(`Purged ${rows.length} replayed dead letter(s) from ci.pipeline_dead_letters`, {
        purged: rows.length,
        retentionDays,
        // A full batch means there is more past the horizon; the next tick takes
        // it. At DEAD_LETTER_PURGE_BATCH per two minutes the drain rate matches
        // the harvest's fill rate exactly, so a backlog cannot outrun this.
        moreLikely: rows.length === limit,
      });
    }

    return rows.length;
  }
}
