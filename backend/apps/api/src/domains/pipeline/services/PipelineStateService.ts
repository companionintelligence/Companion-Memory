import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import {
  CLAIM_LEASE_SECONDS,
  MAX_ATTEMPTS_BEFORE_QUARANTINE,
  RETRY_BACKOFF_BASE_SECONDS,
  RETRY_BACKOFF_MAX_SECONDS,
  SOURCE_CHANGE_GRACE_SECONDS,
  SOURCE_CHANGE_REOPEN_BATCH,
  TRANSIENT_FAILURE_REASONS,
  TRANSIENT_RETRY_BACKOFF_BASE_SECONDS,
  isTransientFailureReason,
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
  /**
   * Delay after the first TRANSIENT failure, in seconds. Doubles per consecutive
   * transient failure and saturates at `maxSeconds`, and unlike the permanent
   * schedule it never ends in quarantine.
   */
  transientBaseSeconds?: number;
}

/** What `releaseQuarantined()` was asked to un-park, and what it found. */
export interface ReleaseQuarantinedInput {
  /**
   * Reasons to release, matched exactly. Defaults to
   * {@link TRANSIENT_FAILURE_REASONS} — the set that can no longer quarantine at
   * all, so the default is precisely "undo what the old policy did".
   */
  reasons?: readonly string[];

  /** Restrict to one stage. Absent means every stage, which is the common case. */
  stage?: string;
}

/** @see PipelineStateService.releaseQuarantined */
export interface ReleaseQuarantinedResult {
  /** Rows moved from `quarantined` back to `failed`, due immediately. */
  released: number;
  /** The reasons actually used, echoed so a defaulted call is self-documenting. */
  reasons: string[];
  /** The stage filter applied, or null when every stage was in scope. */
  stage: string | null;
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
 *  - **A TRANSIENT failure never spends the quarantine budget.** `attempts` is
 *    charged by `claim()` and REFUNDED here when the reason is one of
 *    `TRANSIENT_FAILURE_REASONS`; `transient_attempts` counts those separately
 *    and drives its own long backoff. Two counters exist because one could not
 *    tell the difference between a row that can never succeed and a provider
 *    that was briefly unreachable — and with a five-attempt budget at a 60 s
 *    doubling backoff, fifteen minutes of outage was enough to make the second
 *    look exactly like the first. It cost a real appliance 12,237 quarantined
 *    `ci.position` rows, 19 % of that corpus, none of which could ever get an
 *    address or reach the map again.
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

    // NOT EXISTS, not LEFT JOIN ... WHERE. The two are logically identical here
    // and the anti-join form is the ONLY one that scales — measured on 324,044
    // real events:
    //
    //   ledger empty       LEFT JOIN  Index Only Scan          0.20 ms      37 blocks
    //   50,000 rows done   LEFT JOIN  Parallel Seq Scan       69-81 ms  35,488 blocks
    //   50,000 rows done   NOT EXISTS Merge Anti Join + Index    ~7 ms   7,803 blocks
    //
    // The LEFT JOIN reads `p.stage_version` / `p.status` / `p.next_attempt_at`
    // from the NULL-extended side, so the planner cannot push the predicate down
    // and the LIMIT cannot reach the scan: the whole join is materialised and
    // sorted before six rows come back. Worse than the constant factor, the
    // keyset bound degrades from an `Index Cond` to a `Filter`, so resuming stops
    // costing O(remaining) and a full sweep becomes O(corpus^2 / slice) — about
    // 57.5M block reads for one pass over ci.events.
    //
    // The failure mode is also inverted, which is what makes it easy to miss: it
    // is fast when there is lots of work (every row qualifies, the LIMIT is
    // satisfied immediately) and slowest when the corpus has CONVERGED — the
    // state every idempotent re-sweep runs in permanently. An empty-ledger
    // benchmark reports the best case and hides all of this.
    //
    // The negated inner condition is the exact complement of the LEFT JOIN's OR
    // chain: a row is a candidate unless a ledger row exists that is BOTH at or
    // beyond the current version AND not a due retry.
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT s."${idColumn}" AS id
         FROM "${schema}"."${table}" s
        WHERE s."${userColumn}" = $3
          AND (${applicability})
          AND NOT EXISTS (
                SELECT 1
                  FROM ci.pipeline_state p
                 WHERE p.entity_type = $1
                   AND p.entity_id = s."${idColumn}"
                   AND p.stage = $2
                   AND p.stage_version >= $4
                   AND NOT (p.status = 'failed' AND p.next_attempt_at <= now()))
          AND ($5::uuid IS NULL OR s."${idColumn}" > $5::uuid)
        ORDER BY s."${idColumn}"
        LIMIT $6`,
      [resolvedType, stage.id, userId, stage.version, cursor, limit],
    );

    return rows.map((row) => String(row.id));
  }

  /**
   * Does this leg have at least one FAILED row whose own retry backoff has
   * already elapsed?
   *
   * A direct probe of `pipeline_state_retry_idx` — `(status, next_attempt_at)
   * WHERE status = 'failed'` — narrowed by `stage`, `entity_type` and
   * `user_id`, which the index does not cover but which a "tiny fraction of
   * the table in steady state" (the migration's own words for that index)
   * makes cheap to filter after.
   *
   * Deliberately NOT routed through {@link selectStale}: that statement's
   * `NOT EXISTS` is a join against the STAGE'S OWN SOURCE TABLE, because a
   * fresh or version-bumped candidate is only provable by rejoining the
   * source. A due retry needs no source at all — `ci.pipeline_state` already
   * recorded that the entity exists and that it failed — so this is the
   * ledger alone, `LIMIT 1`, the same "is there anything?" shape as {@link
   * PipelineControlService.hasCandidates} for the same reason: the tick asks
   * once a leg, not once an entity.
   *
   * This is what makes `stageDueness`'s `hasOverdueRetry` input true, which is
   * what lets a leg's retry backoff (minutes to hours) outrank its
   * `minInterval` (up to seven days for a metered stage) — see the "Why
   * `hasOverdueRetry` is a THIRD input" note on `stageDueness` for the failure
   * this closes.
   */
  async hasOverdueRetry(stage: StageRef, entityType: string, userId: string): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ entity_id: string }>>(
      `SELECT entity_id
         FROM ci.pipeline_state
        WHERE stage = $1
          AND entity_type = $2
          AND user_id = $3::uuid
          AND status = 'failed'
          AND next_attempt_at <= now()
        LIMIT 1`,
      [stage.id, entityType, userId],
    );

    return rows.length > 0;
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
   * `attempts` is incremented HERE and nowhere else. The one thing that ever
   * moves it back is the transient REFUND in `complete()`/`fail()`, which is
   * what keeps a provider outage from spending a budget sized for poison
   * records. `stage_version` is deliberately left alone — see the class comment.
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
   * Re-open rows already decided at the current version, so THE ONE RULE
   * re-selects them on the next sweep.
   *
   * Sets `stage_version` back to 0 — the value a fresh claim carries — on
   * TERMINAL rows only. A `running` row is a live claim and is left alone; a
   * `failed` row already has its own retry gate. `status` and `reason` are
   * kept: they still describe the last decision, and the next result
   * overwrites them. Returns how many rows moved.
   *
   * This is the per-row form of a version bump, for the case where new
   * evidence arrived for SOME rows rather than the rule changing for all of
   * them — a name identifier registered after the person-link stage had
   * already claimed the messages naming it (see IdentifierArrivalService), or
   * a place link `promote.place` wrote after `promote.edge_event` had already
   * projected the event (see `STAGE_REOPENS`, applied by
   * PipelineSliceListener), or a source row that changed after it was decided
   * ({@link reopenChangedSources}), or linkage a writer that is not a stage
   * filled in after an edge leg had already projected the row (the maintenance
   * linkers, through `EdgeProjectionReopenService`). Nothing else re-visits a
   * decided row, by design: "tried and produced nothing" is a recorded answer,
   * not an invitation to try again every tick.
   *
   * `manager` runs the re-open on the CALLER's transaction. Pass it when the
   * re-open answers a write the caller is making in that transaction: the
   * decision then re-opens exactly when the write commits, and not at all if
   * it rolls back. Run separately, a crash between the two commits would leave
   * the new linkage written and the old decision standing, and nothing would
   * ever notice.
   */
  async reopen(
    entityType: string,
    stageId: string,
    ids: readonly string[],
    manager?: Pick<EntityManager, 'query'>,
  ): Promise<number> {
    const uniqueIds = [...new Set(ids)];

    if (uniqueIds.length === 0) {
      return 0;
    }

    // The UPDATE is wrapped in a CTE and the OUTER statement is a SELECT, on
    // purpose. TypeORM's Postgres driver resolves a bare `UPDATE … RETURNING`
    // to `[rows, rowCount]` rather than to the rows, so reading `.length` off
    // it counted the tuple: this returned 2 whether it moved no rows or ten
    // thousand. The CTE form comes back as plain rows. `releaseQuarantined()`
    // below hit the same shape and destructures the pair instead.
    const rows: Array<{ entity_id: string }> = await (manager ?? this.dataSource).query(
      `WITH reopened AS (
         UPDATE ci.pipeline_state ps
            SET stage_version = 0,
                updated_at    = now()
          WHERE ps.entity_type = $1
            AND ps.stage = $2
            AND ps.entity_id = ANY($3::uuid[])
            AND ps.status IN ('done', 'skipped')
            AND ps.stage_version > 0
          RETURNING ps.entity_id
       )
       SELECT entity_id FROM reopened`,
      [entityType, stageId, uniqueIds],
    );

    return rows.length;
  }

  /**
   * Re-open this user's decided rows whose SOURCE ROW changed after the
   * decision, for a stage that declares `source.changedAtColumn`. Returns how
   * many rows moved; 0, with no statement, for a stage that declares none.
   *
   * THE ONE RULE re-selects a decided row only when the stage's version moves:
   * it records which RULE produced an answer, not which INPUT. That is right
   * for a stage over rows that never change after they land, and wrong for one
   * whose output is a copy of a row that does — the answer outlives the row it
   * describes until someone bumps a version for an unrelated reason.
   *
   * So this asks the one question the ledger cannot: was the source row
   * stamped after this row was decided? The "when" of a decision is
   * `ci.pipeline_state.updated_at`, which `complete()` writes and nothing else
   * moves on a terminal row. {@link SOURCE_CHANGE_GRACE_SECONDS} widens the
   * comparison for a change that committed while the slice was running; see
   * its note.
   *
   * Scoped to what the sweep would do with the answer, so a re-open is never a
   * lie in `coverage()`: rows the stage APPLIES to (its predicate — a row that
   * stopped applying would sit at version 0, "stale", with nothing ever coming
   * for it), decided at or above the CURRENT version (a row below it is already
   * a candidate), and `done` / `skipped` only, the same rows {@link reopen}
   * moves. The re-open itself is {@link reopen}, so there is one definition of
   * it. Nothing here reads or names the column the stage WRITES.
   */
  async reopenChangedSources(
    stage: Stage,
    userId: string,
    entityType?: string,
    limit: number = SOURCE_CHANGE_REOPEN_BATCH,
  ): Promise<number> {
    const { schema, table, idColumn, userColumn, predicate, changedAtColumn } = stage.source;

    if (changedAtColumn == null) {
      return 0;
    }

    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`reopenChangedSources limit must be a positive integer, got ${String(limit)}`);
    }

    assertIdentifier('schema', schema);
    assertIdentifier('table', table);
    assertIdentifier('id column', idColumn);
    assertIdentifier('user column', userColumn);
    assertIdentifier('changed-at column', changedAtColumn);

    const resolvedType = this.resolveEntityType(stage, entityType);
    const applicability = predicate != null && predicate.trim().length > 0 ? predicate : 'TRUE';

    // EXISTS rather than a JOIN for the reason selectStale gives for NOT EXISTS:
    // the applicability predicate is written over the source alone, and a
    // joined ledger would make its bare column names ambiguous (`entity_type`
    // is on both tables).
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT s."${idColumn}" AS id
         FROM "${schema}"."${table}" s
        WHERE s."${userColumn}" = $3
          AND (${applicability})
          AND EXISTS (
                SELECT 1
                  FROM ci.pipeline_state p
                 WHERE p.entity_type = $1
                   AND p.entity_id = s."${idColumn}"
                   AND p.stage = $2
                   AND p.stage_version >= $4
                   AND p.status IN ('done', 'skipped')
                   AND p.updated_at < s."${changedAtColumn}" + make_interval(secs => $5::float8))
        LIMIT $6`,
      [resolvedType, stage.id, userId, stage.version, SOURCE_CHANGE_GRACE_SECONDS, limit],
    );

    if (rows.length === 0) {
      return 0;
    }

    return this.reopen(
      resolvedType,
      stage.id,
      rows.map((row) => String(row.id)),
    );
  }

  /**
   * Record terminal outcomes for a whole slice in ONE upsert.
   *
   * `done` and `skipped` are stamped with the stage's current version, which is
   * what removes them from the candidate set until that version moves. `failed`
   * additionally gets a retry gate — an exponential backoff computed IN SQL
   * from the row's own counters, so it needs no read-modify-write and cannot
   * race a concurrent claim. Once a row has spent its attempt budget the same
   * statement parks it as `quarantined`, which no sweep reclaims and only a
   * version bump (or a human) revives.
   *
   * ── The two budgets ────────────────────────────────────────────────────────
   *
   * Which budget a failure spends is decided by its REASON, classified in
   * TypeScript above and carried into the statement as a per-row flag:
   *
   *  - **permanent** (anything not in `TRANSIENT_FAILURE_REASONS`) — keeps the
   *    attempt `claim()` charged, backs off `RETRY_BACKOFF_BASE_SECONDS *
   *    2^(attempts-1)`, and quarantines once `attempts` reaches
   *    `MAX_ATTEMPTS_BEFORE_QUARANTINE`. This is the poison-record path and it
   *    is unchanged.
   *  - **transient** (`provider_unavailable`, `ollama_unreachable`) — REFUNDS
   *    the attempt, increments `transient_attempts` instead, backs off
   *    `TRANSIENT_RETRY_BACKOFF_BASE_SECONDS * 2^transient_attempts`, and can
   *    NEVER quarantine. An outage is a fact about the world; it must not
   *    accumulate into a verdict about a row.
   *
   * Anything that is not another transient failure resets `transient_attempts`
   * to 0, so an episode that ends leaves the next one starting at 15 minutes
   * rather than at the 6-hour cap.
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
    const transient: boolean[] = [];

    for (const [entityId, result] of results) {
      this.assertValidResult(stage.id, entityId, result);

      ids.push(entityId);
      statuses.push(result.outcome);
      reasons.push(result.reason ?? null);
      // Classified HERE rather than in SQL so the rule is one pure predicate over
      // a declared set, testable without a database and readable from the reason
      // column afterwards. Only meaningful for `failed`; the statement ignores it
      // for every other outcome.
      transient.push(result.outcome === 'failed' && isTransientFailureReason(result.reason));
    }

    if (ids.length === 0) {
      return { done: 0, skipped: 0, failed: 0, quarantined: 0 };
    }

    // `transient_attempts` does double duty in this statement: it is the column
    // the transient backoff counts, AND it is how the per-row class crosses into
    // the `ON CONFLICT` clause. `DO UPDATE` cannot see `t` — only `ps` and
    // `EXCLUDED` — so the flag rides in on the row we tried to insert, where
    // `EXCLUDED.transient_attempts = 1` means "this failure was the world's
    // fault" and 0 means everything else.
    const rows = await this.dataSource.query<Array<{ status: string }>>(
      `INSERT INTO ci.pipeline_state AS ps
              (entity_type, entity_id, stage, stage_version, status, reason, attempts,
               transient_attempts, next_attempt_at, updated_at)
       SELECT $1, t.entity_id, $2, $3::int, t.status, t.reason,
              CASE WHEN t.transient THEN 0 ELSE 1 END,
              CASE WHEN t.transient THEN 1 ELSE 0 END,
              CASE WHEN t.status = 'failed'
                   THEN now() + make_interval(secs => LEAST(
                          CASE WHEN t.transient THEN $10::float8 ELSE $4::float8 END,
                          $5::float8))
              END,
              now()
         FROM unnest($6::uuid[], $7::text[], $8::text[], $9::bool[])
              AS t(entity_id, status, reason, transient)
       ON CONFLICT (entity_type, entity_id, stage) DO UPDATE
          SET stage_version   = EXCLUDED.stage_version,
              status          = CASE
                                  WHEN EXCLUDED.status = 'failed'
                                   AND EXCLUDED.transient_attempts = 0
                                   AND ps.attempts >= $11::int
                                  THEN 'quarantined'
                                  ELSE EXCLUDED.status
                                END,
              reason          = EXCLUDED.reason,
              -- The refund. claim() charged this row an attempt; a failure the
              -- row did not cause gives it straight back, so an outage of any
              -- length leaves the quarantine budget exactly where it was.
              attempts        = CASE
                                  WHEN EXCLUDED.status = 'failed'
                                   AND EXCLUDED.transient_attempts = 1
                                  THEN GREATEST(ps.attempts - 1, 0)
                                  ELSE ps.attempts
                                END,
              transient_attempts = CASE
                                  WHEN EXCLUDED.status = 'failed'
                                   AND EXCLUDED.transient_attempts = 1
                                  THEN ps.transient_attempts + 1
                                  ELSE 0
                                END,
              next_attempt_at = CASE
                                  WHEN EXCLUDED.status = 'failed'
                                   AND EXCLUDED.transient_attempts = 1
                                  THEN now() + make_interval(secs => LEAST(
                                         $10::float8 * power(2, ps.transient_attempts),
                                         $5::float8))
                                  WHEN EXCLUDED.status = 'failed' AND ps.attempts < $11::int
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
        transient,
        TRANSIENT_RETRY_BACKOFF_BASE_SECONDS,
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
   *
   * A shared reason that names a TRANSIENT failure takes the same escape hatch
   * `complete()` does — refund the attempt, count it in `transient_attempts`,
   * back off on the long schedule, never quarantine. One reason for the whole
   * slice means one class for the whole slice, so the flag is a scalar here
   * rather than the per-row array `complete()` binds.
   *
   * Note that the DEFAULT reason from `PipelineSliceListener` is
   * `stage_threw: <message>`, which is not classifiable and therefore permanent
   * — see `TRANSIENT_FAILURE_REASONS` for why pattern-matching an error message
   * is not offered, and `releaseQuarantined()` for the operator's remedy when a
   * real outage came through that path.
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
    const transientBaseSeconds = options.transientBaseSeconds ?? TRANSIENT_RETRY_BACKOFF_BASE_SECONDS;
    const transient = isTransientFailureReason(reason.trim());

    if (
      !Number.isFinite(baseSeconds) ||
      baseSeconds < 0 ||
      !Number.isFinite(maxSeconds) ||
      maxSeconds < 0 ||
      !Number.isFinite(transientBaseSeconds) ||
      transientBaseSeconds < 0
    ) {
      throw new Error(
        `Invalid retry backoff for stage "${stage.id}": base=${String(baseSeconds)}s max=${String(maxSeconds)}s ` +
          `transientBase=${String(transientBaseSeconds)}s. A NaN gate would make next_attempt_at NULL and the ` +
          `row would never be retried.`,
      );
    }

    // `$9::bool` is the whole slice's class, so unlike `complete()` it can be
    // read directly in the `ON CONFLICT` clause — a bound parameter is visible
    // there, the `t` alias is not.
    const rows = await this.dataSource.query<Array<{ status: string }>>(
      `INSERT INTO ci.pipeline_state AS ps
              (entity_type, entity_id, stage, stage_version, status, reason, attempts,
               transient_attempts, next_attempt_at, updated_at)
       SELECT $1, t.entity_id, $2, $3::int, 'failed', $4,
              CASE WHEN $9::bool THEN 0 ELSE 1 END,
              CASE WHEN $9::bool THEN 1 ELSE 0 END,
              now() + make_interval(secs => LEAST(
                CASE WHEN $9::bool THEN $10::float8 ELSE $5::float8 END,
                $6::float8)),
              now()
         FROM unnest($7::uuid[]) AS t(entity_id)
       ON CONFLICT (entity_type, entity_id, stage) DO UPDATE
          SET stage_version   = EXCLUDED.stage_version,
              status          = CASE
                                  WHEN NOT $9::bool AND ps.attempts >= $8::int THEN 'quarantined'
                                  ELSE 'failed'
                                END,
              reason          = EXCLUDED.reason,
              -- The refund: an outage must leave the quarantine budget untouched,
              -- however long it lasts. See the class comment's invariants.
              attempts        = CASE
                                  WHEN $9::bool THEN GREATEST(ps.attempts - 1, 0)
                                  ELSE ps.attempts
                                END,
              transient_attempts = CASE
                                  WHEN $9::bool THEN ps.transient_attempts + 1
                                  ELSE 0
                                END,
              next_attempt_at = CASE
                                  WHEN $9::bool
                                  THEN now() + make_interval(secs => LEAST(
                                         $10::float8 * power(2, ps.transient_attempts),
                                         $6::float8))
                                  WHEN ps.attempts >= $8::int THEN NULL
                                  ELSE now() + make_interval(secs => LEAST(
                                         $5::float8 * power(2, GREATEST(ps.attempts - 1, 0)),
                                         $6::float8))
                                END,
              updated_at      = now()
       RETURNING ps.status`,
      [
        entityType,
        stage.id,
        stage.version,
        reason,
        baseSeconds,
        maxSeconds,
        uniqueIds,
        maxAttempts,
        transient,
        transientBaseSeconds,
      ],
    );

    return this.tally(rows);
  }

  /**
   * Move quarantined rows BACK to `failed`, due now, for named reasons.
   *
   * ── Why this exists ────────────────────────────────────────────────────────
   *
   * Quarantine has exactly one exit today: bump the stage's version, which
   * re-opens the WHOLE corpus. On a `cost: 'metered'` stage that is a bill for
   * every row in the table in order to retry a few thousand, which is why the
   * honest answer to "the provider had an outage last night" has been to do
   * nothing. This is the targeted lever: name the reasons, re-open only the rows
   * that carry them.
   *
   * The classified transient reasons can no longer quarantine at all, so the
   * rows this finds are either from a build that predates that fix (which the
   * accompanying migration already released once) or, more usefully, carry a
   * reason the declared set deliberately does NOT cover — `stage_threw:
   * ECONNREFUSED …`, `provider_status_unrecognized`, `embedding_write_failed`
   * during a Postgres restart. Those are unclassifiable at write time, because
   * classifying them means pattern-matching an error message. They are perfectly
   * classifiable AFTERWARDS by a human who knows what was broken, and that human
   * is who this is for.
   *
   * ── Why re-attempting is safe ──────────────────────────────────────────────
   *
   * A released row goes back to `failed` with a due gate — the ordinary state of
   * a row awaiting retry — so nothing downstream sees a state it does not
   * already handle. `attempts` is reset so the retry starts from a full budget,
   * and `transient_attempts` with it. If the underlying cause is still present
   * the row simply fails again and re-quarantines on its own schedule: the worst
   * outcome of a wrong call here is the work of one more attempt per row, which
   * is why this is `write` and not `full`.
   *
   * REASONS ARE REQUIRED to be meaningful — an empty list is a no-op returning
   * zero, never "release everything". Blanket release is the operation that
   * re-runs the same broken config over the entire ledger, which is the same
   * argument `replayDeadLetters` makes for refusing an empty selector.
   */
  async releaseQuarantined(
    userId: string,
    input: ReleaseQuarantinedInput = {},
  ): Promise<ReleaseQuarantinedResult> {
    const reasons = [...new Set(input.reasons ?? [...TRANSIENT_FAILURE_REASONS])].filter(
      (reason) => reason.trim().length > 0,
    );
    const stage = input.stage ?? null;

    if (reasons.length === 0) {
      return { released: 0, reasons, stage };
    }

    // `next_attempt_at = now()` rather than a stagger: what a release costs is
    // bounded by the stage's own schedule (window, `minInterval`, `perRunCap`),
    // not by how many rows become due at once. Making them due is this
    // statement's whole job; deciding when to spend on them is not.
    // TypeORM's Postgres driver special-cases UPDATE/DELETE and resolves
    // `[rows, rowCount]`, NOT the rows array — so reading `.length` off the
    // result counts the tuple (always 2), not the rows touched. `released` was
    // therefore a constant 2 regardless of how many rows moved, which is what
    // the two `releases quarantined rows by reason` integration tests catch.
    // Destructure the pair, exactly as personalization/placement.ts:290-311
    // already documents and defends against.
    const [rows] = (await this.dataSource.query(
      `UPDATE ci.pipeline_state
          SET status             = 'failed',
              attempts           = 0,
              transient_attempts = 0,
              next_attempt_at    = now(),
              updated_at         = now()
        WHERE status = 'quarantined'
          AND user_id = $1::uuid
          AND reason = ANY($2::text[])
          AND ($3::text IS NULL OR stage = $3::text)
        RETURNING entity_id`,
      [userId, reasons, stage],
    )) as [Array<{ entity_id: string }>, number];

    if (rows.length > 0) {
      this.logger.log('Released quarantined ledger rows', {
        userId,
        stage,
        reasons,
        released: rows.length,
      });
    }

    return { released: rows.length, reasons, stage };
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
