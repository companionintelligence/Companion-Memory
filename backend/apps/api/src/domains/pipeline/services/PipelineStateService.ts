import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import {
  CLAIM_LEASE_SECONDS,
  MAX_ATTEMPTS_BEFORE_QUARANTINE,
  RETRY_BACKOFF_BASE_SECONDS,
  RETRY_BACKOFF_MAX_SECONDS,
} from '../constants';
import type {
  DeadLetterInput,
  LedgerWriteSummary,
  Stage,
  StageCoverage,
  StageRef,
  StageResult,
} from '../types';
import { stageVersion } from '../versions';

/**
 * How long before a failed entity becomes eligible again.
 *
 * The value names the wait after the FIRST failure, not the whole schedule: the
 * gate actually written is `base * 2^(attempts - 1)`, capped, so a slice
 * failing against a dead dependency backs away instead of hammering it every
 * minute forever. Defaults come from `constants.ts`.
 *
 * Two spellings, because both call sites are natural and each states its own
 * unit, so neither can be misread: a bare number is MILLISECONDS (what a caller
 * reaching for "wait 30 seconds" writes as `30_000`), and the object form is in
 * SECONDS, spelled out in the property name. There is no unit to infer at
 * either call site — the only thing worse than two units would be one unit you
 * have to look up.
 */
export type RetryBackoff = number | RetryBackoffOptions;

export interface RetryBackoffOptions {
  /** Delay after the first failure, in seconds. Doubles per attempt. */
  baseSeconds?: number;
  /** Ceiling the doubling saturates at, in seconds. */
  maxSeconds?: number;
  /** Attempts after which the entity is quarantined instead of retried. */
  maxAttempts?: number;
}

/**
 * Row shape of the grouped coverage query. `count(*)` is bigint, which node-pg
 * hands back as a string rather than silently truncating past 2^53.
 */
interface CoverageRow {
  status: string;
  count: number | string;
  stale: number | string;
}

/**
 * SQL identifiers arrive from `StageSource`, which is in-repo declaration and
 * never request input — the same trust boundary `OrphanCleanupService` relies
 * on. The pattern check is not a sanitiser (there is nothing to sanitise); it
 * is a tripwire so a stage that computes a table name from data gets a legible
 * error at its first sweep instead of producing a syntactically valid query
 * over something unexpected.
 */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(kind: string, value: string): void {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid SQL ${kind} "${value}" in a StageSource. Identifiers are interpolated into the staleness ` +
        `sweep and must be plain in-repo literals matching ${String(SQL_IDENTIFIER)}.`,
    );
  }
}

/**
 * The ledger. Everything the pipeline knows about what has been processed lives
 * in `ci.pipeline_state`, and this is the only thing that writes it.
 *
 * ── Why a ledger at all ────────────────────────────────────────────────────
 *
 * Every enrichment leg in this codebase historically encoded "has this run?" as
 * a nullability predicate on the column it writes: `width IS NULL`,
 * `location_coordinates IS NULL`, `LEFT JOIN ci_search.embeddings ... WHERE
 * e.entity_id IS NULL`, `cardinality(to_entity_ids) = 0`. The predicate that
 * finds work is the predicate that declares it done, which has three
 * consequences no amount of care at the call site can fix:
 *
 *  1. The first — worst — answer an enricher ever produced is permanent.
 *     Improving the enricher cannot repair history.
 *  2. "Tried and legitimately produced nothing" is indistinguishable from
 *     "never tried". An unreadable image is re-fetched from object storage and
 *     re-decoded on every single run, forever.
 *  3. There is no answer to "is the import finished?", because nothing counts
 *     anything.
 *
 * The ledger separates the three facts that predicate conflated: whether the
 * stage ran (`status`), what it decided (`status` + `reason`), and which
 * version of the stage decided it (`stage_version`).
 *
 * ── Invariants worth knowing before changing anything here ─────────────────
 *
 *  - **`claim()` never advances `stage_version`.** A version is a claim about
 *    what produced a RESULT, and a claim produces no result. This is also what
 *    makes crash recovery work: a row left in `status='running'` by a killed
 *    worker keeps the INSERT default of 0, so `stage_version < $current`
 *    re-selects it on the next sweep. If claim stamped the version, that row
 *    would satisfy no arm of the staleness predicate and the entity would be
 *    stranded permanently. (This is also why `versions.ts` refuses a version
 *    of 0.)
 *  - **Every write is ONE statement.** `unnest()` over parallel arrays, one
 *    `ON CONFLICT` upsert per call, no per-id loop. A 200-id slice is one round
 *    trip. The per-row `UPDATE` version of this pattern is exactly why the
 *    communication-link backfill never finished over a 22-year history.
 *  - **`skipped` and `failed` must carry a reason**, enforced here, before
 *    anything is written. The database deliberately does NOT enforce it with a
 *    CHECK: a constraint that can reject the error path turns a recoverable
 *    failure into a lost one.
 */
@Injectable()
export class PipelineStateService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PipelineStateService.name);
  }

  /**
   * THE ONE RULE — the canonical staleness sweep every stage uses.
   *
   * ```sql
   * SELECT s."<idCol>" AS id
   *   FROM "<schema>"."<table>" s
   *   LEFT JOIN ci.pipeline_state p
   *     ON p.entity_type = $1 AND p.entity_id = s."<idCol>" AND p.stage = $2
   *  WHERE s."<userCol>" = $3
   *    AND (<stage applicability predicate>)
   *    AND ( p.entity_id IS NULL                                    -- never processed
   *       OR p.stage_version < $4                                   -- enricher improved
   *       OR (p.status = 'failed' AND p.next_attempt_at <= now()) ) -- retry is due
   *    AND ($5::uuid IS NULL OR s."<idCol>" > $5::uuid)             -- keyset cursor
   *  ORDER BY s."<idCol>"
   *  LIMIT $6;
   * ```
   *
   * Read the three arms of the middle clause as the entire re-processing
   * policy, because they are:
   *
   *  - **no ledger row** — the entity has never been offered to this stage,
   *    including entities created before the stage existed;
   *  - **`stage_version` below current** — the stage improved, so every earlier
   *    answer is provisional. This is the arm the rebuild exists for, and the
   *    reason bumping an integer in `versions.ts` is a complete re-enrichment
   *    mechanism;
   *  - **`failed` with a due retry gate** — transient failures come back on
   *    their own schedule, which survives a process restart because it is a
   *    column and not a timer.
   *
   * `done`, `skipped` and `quarantined` rows at the current version are all
   * excluded, so a second sweep over a converged corpus returns nothing — the
   * property that makes "is my import finished?" answerable.
   *
   * The sweep reads exactly two tables: the source and the ledger. It must
   * never mention the column the stage writes, and it must never anti-join the
   * stage's output table — `LEFT JOIN ci_search.embeddings ... WHERE
   * e.entity_id IS NULL` is the same ratchet wearing a different hat.
   *
   * The cursor is a KEYSET, not an OFFSET: resuming costs O(remaining) rather
   * than O(processed), and rows inserted into the source mid-sweep can neither
   * be skipped nor handed out twice.
   *
   * @param entityType required only for stages declaring more than one type,
   * because the ledger join is per `(entity_type, entity_id, stage)`.
   */
  async selectStale(
    stage: Stage,
    userId: string,
    cursor: string | null,
    limit: number,
    entityType?: string,
  ): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`selectStale limit must be a positive integer, got ${String(limit)}`);
    }

    const { schema, table, idColumn, userColumn, predicate } = stage.source;

    assertIdentifier('schema', schema);
    assertIdentifier('table', table);
    assertIdentifier('id column', idColumn);
    assertIdentifier('user column', userColumn);

    const resolvedType = this.resolveEntityType(stage, entityType);

    // An absent applicability predicate means "every row in the table is a
    // candidate", spelled as TRUE so the generated SQL keeps one shape and is
    // greppable in a query log either way.
    const applicability = predicate != null && predicate.trim().length > 0 ? predicate : 'TRUE';

    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT s."${idColumn}" AS id
         FROM "${schema}"."${table}" s
         LEFT JOIN ci.pipeline_state p
           ON p.entity_type = $1 AND p.entity_id = s."${idColumn}" AND p.stage = $2
        WHERE s."${userColumn}" = $3
          AND (${applicability})
          AND ( p.entity_id IS NULL
             OR p.stage_version < $4
             OR (p.status = 'failed' AND p.next_attempt_at <= now()) )
          AND ($5::uuid IS NULL OR s."${idColumn}" > $5::uuid)
        ORDER BY s."${idColumn}"
        LIMIT $6`,
      [resolvedType, stage.id, userId, stage.version, cursor, limit],
    );

    return rows.map((row) => String(row.id));
  }

  /**
   * Mark ids `running` and charge them an attempt. Returns the ids ACTUALLY
   * claimed, which is not always what was asked for.
   *
   * The claim is what makes the dispatcher safe to run concurrently with
   * itself. Two sweeps that overlap (an operator clicking twice, a cron
   * overlapping its own previous run, a replayed dead letter racing a live
   * sweep) will hand the same ids to two workers; the `ON CONFLICT ... WHERE`
   * clause lets exactly one of them take the rows, and the loser gets a shorter
   * list back and does correspondingly less work. Nothing is corrupted either
   * way — stages are required to be idempotent — but the common case stops
   * costing double.
   *
   * This is a cooperative lease, NOT a lock: a worker that is SIGKILLed never
   * releases anything, so the claim expires after {@link CLAIM_LEASE_SECONDS}
   * and the rows become claimable again. A lease that lives in a column
   * survives the process that took it; one held in memory does not.
   *
   * The second half of the conflict guard refuses ids that are already TERMINAL
   * at the current version. Those should never arrive — the sweep does not
   * select them — but they do: from a slice enqueued before the row was
   * completed and worked after. Re-running them is wasted work at best and, for
   * a stage with side effects, a duplicate at worst. Rows below the current
   * version, and non-terminal rows at any version, stay claimable, so version
   * bumps and crash recovery both still work.
   *
   * `attempts` is incremented HERE and nowhere else, so it counts genuine
   * starts. `stage_version` is deliberately left alone — see the class comment.
   */
  async claim(stage: StageRef, entityType: string, ids: string[], userId: string | null): Promise<string[]> {
    const uniqueIds = [...new Set(ids)];

    if (uniqueIds.length === 0) {
      return [];
    }

    // ON CONFLICT cannot touch the same row twice in one statement ("cannot
    // affect row a second time"), so a duplicated id in the input would abort
    // the whole claim rather than being harmlessly idempotent. Deduped above.
    //
    // The inserted `stage_version` is a literal 0, NOT the stage's version. It
    // is the most load-bearing zero in this file: it is what leaves a row
    // abandoned by a killed worker visible to the next sweep.
    const rows = await this.dataSource.query<Array<{ entity_id: string }>>(
      `INSERT INTO ci.pipeline_state AS ps
              (entity_type, entity_id, stage, stage_version, status, attempts, next_attempt_at,
               user_id, updated_at)
       SELECT $1, t.entity_id, $2, 0, 'running', 1, NULL, $3::uuid, now()
         FROM unnest($4::uuid[]) AS t(entity_id)
       ON CONFLICT (entity_type, entity_id, stage) DO UPDATE
          SET status          = 'running',
              attempts        = ps.attempts + 1,
              next_attempt_at = NULL,
              user_id         = COALESCE($3::uuid, ps.user_id),
              updated_at      = now()
        WHERE (ps.status <> 'running' OR ps.updated_at < now() - make_interval(secs => $6::float8))
          AND (ps.stage_version < $5::int OR ps.status IN ('pending', 'running', 'failed'))
       RETURNING ps.entity_id`,
      [entityType, stage.id, userId, uniqueIds, stage.version, CLAIM_LEASE_SECONDS],
    );

    const claimed = rows.map((row) => String(row.entity_id));

    if (claimed.length < uniqueIds.length) {
      // Not an error: the difference is rows another worker holds a live claim
      // on, or rows already terminal at this version. Logged because a
      // persistent gap means two dispatchers are sweeping the same stage in
      // lockstep and one of them is pure waste.
      this.logger.debug('Some ids were not claimable', {
        stage: stage.id,
        entityType,
        requested: uniqueIds.length,
        claimed: claimed.length,
      });
    }

    return claimed;
  }

  /**
   * Record terminal outcomes for a whole slice in ONE upsert.
   *
   * `done` and `skipped` are stamped with the stage's current version, which is
   * what removes them from the candidate set until that version moves. `failed`
   * additionally gets a retry gate — an exponential backoff computed IN SQL
   * from the row's own `attempts`, so it needs no read-modify-write and cannot
   * race a concurrent claim. Once a row has spent its attempt budget the same
   * statement parks it as `quarantined`, which no sweep reclaims and only a
   * version bump (or a human) revives.
   *
   * Rejects `skipped`/`failed` results carrying no reason, before writing
   * anything. A stage that cannot say why it skipped a row has not skipped it,
   * it has lost it — and a nameless skip is indistinguishable, three months
   * later, from data that never arrived.
   *
   * `user_id` is stamped by {@link claim} and never overwritten here: complete()
   * is not told the user, and guessing NULL would erase it.
   *
   * NOTE: `confidence` and `detail` are validated but not yet persisted —
   * `ci.pipeline_state` has no column for either. They land in
   * `ci.derived_facts` when that table arrives; until then a stage may return
   * them and they are simply not stored.
   */
  async complete(
    stage: StageRef,
    entityType: string,
    results: Map<string, StageResult>,
  ): Promise<LedgerWriteSummary> {
    const ids: string[] = [];
    const statuses: string[] = [];
    const reasons: (string | null)[] = [];

    for (const [entityId, result] of results) {
      this.assertValidResult(stage.id, entityId, result);

      ids.push(entityId);
      statuses.push(result.outcome);
      reasons.push(result.reason ?? null);
    }

    if (ids.length === 0) {
      return { done: 0, skipped: 0, failed: 0, quarantined: 0 };
    }

    const rows = await this.dataSource.query<Array<{ status: string }>>(
      `INSERT INTO ci.pipeline_state AS ps
              (entity_type, entity_id, stage, stage_version, status, reason, attempts,
               next_attempt_at, updated_at)
       SELECT $1, t.entity_id, $2, $3::int, t.status, t.reason, 1,
              CASE WHEN t.status = 'failed'
                   THEN now() + make_interval(secs => LEAST($4::float8, $5::float8))
              END,
              now()
         FROM unnest($6::uuid[], $7::text[], $8::text[]) AS t(entity_id, status, reason)
       ON CONFLICT (entity_type, entity_id, stage) DO UPDATE
          SET stage_version   = EXCLUDED.stage_version,
              status          = CASE
                                  WHEN EXCLUDED.status = 'failed' AND ps.attempts >= $9::int
                                  THEN 'quarantined'
                                  ELSE EXCLUDED.status
                                END,
              reason          = EXCLUDED.reason,
              next_attempt_at = CASE
                                  WHEN EXCLUDED.status = 'failed' AND ps.attempts < $9::int
                                  THEN now() + make_interval(secs => LEAST(
                                         $4::float8 * power(2, GREATEST(ps.attempts - 1, 0)),
                                         $5::float8))
                                END,
              updated_at      = now()
       RETURNING ps.status`,
      [
        entityType,
        stage.id,
        stage.version,
        RETRY_BACKOFF_BASE_SECONDS,
        RETRY_BACKOFF_MAX_SECONDS,
        ids,
        statuses,
        reasons,
        MAX_ATTEMPTS_BEFORE_QUARANTINE,
      ],
    );

    // Tallied from RETURNING rather than from the input map, because the
    // failed → quarantined promotion is decided in SQL and the caller's log
    // line should report what was actually written.
    return this.tally(rows);
  }

  /**
   * Fail a set of ids for one shared reason, with backoff.
   *
   * The slice-level counterpart to a per-entity `failed` result: used when the
   * failure was not attributable to any one row (the stage threw, the payload
   * was unusable, an upstream dependency was down), so every id in the slice
   * gets the same reason and the same retry gate.
   *
   * The backoff is `base * 2^(attempts - 1)`, capped, evaluated in SQL against
   * the row's own attempt count. Rows that have spent the attempt budget become
   * `quarantined` with a NULL gate: the sweep only reclaims `failed` rows, so
   * quarantine is what stops one poison record from burning a worker slot every
   * hour forever. It is not permanent — a version bump re-selects quarantined
   * rows along with everything else, so a fixed enricher re-admits its own
   * casualties.
   */
  async fail(
    stage: StageRef,
    entityType: string,
    ids: string[],
    reason: string,
    backoff: RetryBackoff = {},
  ): Promise<LedgerWriteSummary> {
    if (reason.trim().length === 0) {
      throw new Error(
        `PipelineStateService.fail requires a non-empty reason (stage "${stage.id}"). A failure with no ` +
          `recorded reason is the defect this ledger exists to remove.`,
      );
    }

    const uniqueIds = [...new Set(ids)];

    if (uniqueIds.length === 0) {
      return { done: 0, skipped: 0, failed: 0, quarantined: 0 };
    }

    const options: RetryBackoffOptions =
      typeof backoff === 'number' ? { baseSeconds: backoff / 1000 } : backoff;

    const baseSeconds = options.baseSeconds ?? RETRY_BACKOFF_BASE_SECONDS;
    const maxSeconds = options.maxSeconds ?? RETRY_BACKOFF_MAX_SECONDS;
    const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS_BEFORE_QUARANTINE;

    if (!Number.isFinite(baseSeconds) || baseSeconds < 0 || !Number.isFinite(maxSeconds) || maxSeconds < 0) {
      throw new Error(
        `Invalid retry backoff for stage "${stage.id}": base=${String(baseSeconds)}s max=${String(maxSeconds)}s. ` +
          `A NaN gate would make next_attempt_at NULL and the row would never be retried.`,
      );
    }

    const rows = await this.dataSource.query<Array<{ status: string }>>(
      `INSERT INTO ci.pipeline_state AS ps
              (entity_type, entity_id, stage, stage_version, status, reason, attempts,
               next_attempt_at, updated_at)
       SELECT $1, t.entity_id, $2, $3::int, 'failed', $4, 1,
              now() + make_interval(secs => LEAST($5::float8, $6::float8)),
              now()
         FROM unnest($7::uuid[]) AS t(entity_id)
       ON CONFLICT (entity_type, entity_id, stage) DO UPDATE
          SET stage_version   = EXCLUDED.stage_version,
              status          = CASE WHEN ps.attempts >= $8::int THEN 'quarantined' ELSE 'failed' END,
              reason          = EXCLUDED.reason,
              next_attempt_at = CASE
                                  WHEN ps.attempts >= $8::int THEN NULL
                                  ELSE now() + make_interval(secs => LEAST(
                                         $5::float8 * power(2, GREATEST(ps.attempts - 1, 0)),
                                         $6::float8))
                                END,
              updated_at      = now()
       RETURNING ps.status`,
      [entityType, stage.id, stage.version, reason, baseSeconds, maxSeconds, uniqueIds, maxAttempts],
    );

    return this.tally(rows);
  }

  /**
   * Ledger coverage for one stage — the answer to "is my import finished?",
   * which the system has never been able to give. `IngestStatusService` counts
   * the depth of one pg-boss queue and `JobMonitorService` reads
   * `pgboss.archive`; neither can tell you whether any particular row was ever
   * processed, which is how `content` sat at zero embedded rows unnoticed.
   *
   * Counts come from `ci.pipeline_state` ALONE, so `total` means "rows this
   * stage has recorded an opinion about" and NOT "rows that exist". Measuring
   * eligibility requires the stage's own source table and applicability
   * predicate, which is the sweep's job, not the ledger's — quoting `coverage`
   * as a completion percentage without an eligible-row count beside it would be
   * exactly the unearned confidence this subsystem replaces.
   *
   * Accepts a stage id or a Stage, because both callers exist: an HTTP
   * controller has a string off the query params, a worker has the stage.
   */
  async coverage(stage: string | StageRef): Promise<StageCoverage> {
    const stageId = typeof stage === 'string' ? stage : stage.id;
    const version = stageVersion(stageId);

    const rows = await this.dataSource.query<CoverageRow[]>(
      `SELECT status,
              count(*) AS count,
              count(*) FILTER (WHERE stage_version < $2::int) AS stale
         FROM ci.pipeline_state
        WHERE stage = $1
        GROUP BY status`,
      [stageId, version],
    );

    // Zero-filled up front. An absent bucket is a zero, and a zero is a fact —
    // "is my import finished?" must never be answered with `undefined`.
    const result: StageCoverage = {
      stage: stageId,
      stageVersion: version,
      total: 0,
      pending: 0,
      running: 0,
      done: 0,
      skipped: 0,
      failed: 0,
      quarantined: 0,
      stale: 0,
      coverage: 0,
    };

    for (const row of rows) {
      const count = Number(row.count);

      result.total += count;
      result.stale += Number(row.stale ?? 0);

      switch (row.status) {
        case 'pending':
          result.pending += count;
          break;
        case 'running':
          result.running += count;
          break;
        case 'done':
          result.done += count;
          break;
        case 'skipped':
          result.skipped += count;
          break;
        case 'failed':
          result.failed += count;
          break;
        case 'quarantined':
          result.quarantined += count;
          break;
        default:
          // The column carries a CHECK over exactly six values, so this is
          // unreachable short of a migration adding a seventh. Counted into
          // `total` above and warned about rather than dropped, because a
          // silently uncounted status would make coverage read high — the one
          // direction this number must never be wrong in.
          this.logger.warn('Unrecognised pipeline_state status in coverage query', {
            stage: stageId,
            status: row.status,
            count,
          });
          break;
      }
    }

    result.coverage = result.total === 0 ? 0 : (result.done + result.skipped) / result.total;

    return result;
  }

  /**
   * Persist one terminally-failed job with its payload intact.
   *
   * pg-boss archives a failed job and then expires the archive, which is
   * correct for a queue and wrong for an appliance: the failed payload is
   * routinely the only surviving copy of a record the source will not re-send.
   * A dead letter is REPLAYABLE — `payload` plus `eventName` is everything
   * needed to re-emit it.
   *
   * The set-based sibling of this method lives in `DeadLetterReaperListener`,
   * which copies pg-boss's own dead-letter queue in bulk. Both write this one
   * table; the two paths are distinguishable by `queue` (a stage queue here,
   * `dead-letter` there).
   *
   * `id` is left to the column default (`ci.gen_uuid_v7()`) so rows sort by
   * insertion time.
   */
  async recordDeadLetter(input: DeadLetterInput): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ci.pipeline_dead_letters
              (queue, event_name, stage, entity_type, entity_id, payload, error)
       VALUES ($1, $2, $3, $4, $5::uuid, $6::jsonb, $7)`,
      [
        input.queue,
        input.eventName,
        input.stage ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        JSON.stringify(input.payload ?? {}),
        input.error,
      ],
    );
  }

  /**
   * Which `entity_type` a sweep is running under.
   *
   * Single-type stages (nearly all of them) never pass one. A multi-type stage
   * MUST, because `ci.pipeline_state` is keyed per type and guessing would
   * silently write one type's progress under another's key — the rows would
   * look processed to one sweep and missing to the other.
   */
  private resolveEntityType(stage: Stage, entityType?: string): string {
    if (entityType != null) {
      if (!stage.entityTypes.includes(entityType)) {
        throw new Error(
          `Stage "${stage.id}" does not declare entity type "${entityType}" ` +
            `(declares: ${stage.entityTypes.join(', ')}).`,
        );
      }

      return entityType;
    }

    if (stage.entityTypes.length !== 1) {
      throw new Error(
        `Stage "${stage.id}" declares ${stage.entityTypes.length} entity types ` +
          `(${stage.entityTypes.join(', ')}), so the sweep must be told which one to run.`,
      );
    }

    return stage.entityTypes[0];
  }

  /**
   * Contract enforcement, run before a single row is written so a bad result
   * cannot be half-persisted.
   */
  private assertValidResult(stageId: string, entityId: string, result: StageResult): void {
    if (result.outcome !== 'done' && result.outcome !== 'skipped' && result.outcome !== 'failed') {
      throw new Error(
        `Stage "${stageId}" returned unknown outcome "${String(result.outcome)}" for entity ${entityId}.`,
      );
    }

    if (result.outcome !== 'done' && (result.reason == null || result.reason.trim().length === 0)) {
      throw new Error(
        `Stage "${stageId}" returned "${result.outcome}" for entity ${entityId} with no reason. ` +
          `A reason is REQUIRED for skipped and failed results — it is the difference between a row that ` +
          `was deliberately not processed and one that was silently dropped.`,
      );
    }

    if (result.confidence != null && (result.confidence <= 0 || result.confidence > 1)) {
      throw new Error(
        `Stage "${stageId}" returned confidence ${result.confidence} for entity ${entityId}; ` +
          `confidence must be in (0, 1]. A fabricated confidence teaches promotion to prefer a worse ` +
          `answer over a measured one.`,
      );
    }
  }

  /** Tally the statuses a write actually produced. */
  private tally(rows: Array<{ status: string }>): LedgerWriteSummary {
    const summary: LedgerWriteSummary = { done: 0, skipped: 0, failed: 0, quarantined: 0 };

    for (const row of rows) {
      if (row.status === 'done') {
        summary.done += 1;
      } else if (row.status === 'skipped') {
        summary.skipped += 1;
      } else if (row.status === 'failed') {
        summary.failed += 1;
      } else if (row.status === 'quarantined') {
        summary.quarantined += 1;
      }
    }

    return summary;
  }
}
