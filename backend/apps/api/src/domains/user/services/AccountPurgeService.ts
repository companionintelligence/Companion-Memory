import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { PURGE_OBJECT_STORE, type PurgeObjectStore } from '../purge/objectStore';
import { expandToPhysicalTables, readFkEdges, readUserRefColumns } from '../purge/purgeCatalog';
import { buildPurgePlan } from '../purge/purgePlan';
import { renderBatchedDelete, renderBatchedNull, renderDeleteUser } from '../purge/purgeSql';
import type { PurgePlan, PurgeStep, TableRef } from '../purge/types';

const USERS_TABLE: TableRef = { schema: 'ci', table: 'users' };

/**
 * Advisory-lock namespace. Two API instances against one appliance database must
 * not purge the same account concurrently: both would run the same statements,
 * and the loser would see rows vanish under its batch loop.
 */
const ADVISORY_LOCK_NAMESPACE = 'ci.account_purge';

/**
 * Ceiling on batches per step. A batch that always reports a full page without
 * making progress would otherwise spin forever; this converts that bug into a
 * loud failure with the step that caused it.
 */
const MAX_BATCHES_PER_STEP = 100_000;

/** Accounts whose deletion grace period has expired and whose purge is unfinished. */
const DUE_ACCOUNTS_SQL = `
  SELECT u.id           AS id,
         u.deleted_at   AS deleted_at,
         u.purge_after  AS purge_after
  FROM ci.users u
  LEFT JOIN ci.account_purges p ON p.user_id = u.id
  WHERE u.deleted_at IS NOT NULL
    AND u.purge_after IS NOT NULL
    AND u.purge_after <= $1
    AND p.completed_at IS NULL
    AND (p.next_attempt_after IS NULL OR p.next_attempt_after <= $1)
  ORDER BY u.purge_after ASC
  LIMIT $2
`;

/**
 * Soft-deleted accounts with no pinned deadline. `requestDeletion` always writes
 * both columns, so this can only be a row deleted by some other path. The purge
 * deliberately will not guess a deadline for them — a promise nobody made is not
 * one to enforce irreversibly — but it does count them, so "nothing is being
 * purged" never looks like "nothing is due".
 */
const UNPINNED_ACCOUNTS_SQL = `
  SELECT count(*)::int AS count
  FROM ci.users
  WHERE deleted_at IS NOT NULL AND purge_after IS NULL
`;

/**
 * Objects owned solely by this account. The `NOT EXISTS` clause matters: file
 * rows are deduplicated on content, so two accounts can point at one object.
 * Deleting the bytes out from under the other account would be a data-loss bug
 * caused by a privacy feature.
 */
const PURGEABLE_OBJECTS_SQL = `
  SELECT DISTINCT f.bucket AS bucket, f.key AS key
  FROM ci.files f
  WHERE f.user_id = $1
    AND f.bucket IS NOT NULL
    AND f.key IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM ci.files o
      WHERE o.bucket = f.bucket AND o.key = f.key AND o.user_id <> $1
    )
  ORDER BY f.bucket, f.key
  LIMIT $2 OFFSET $3
`;

export interface AccountPurgeOutcome {
  userId: string;
  status: 'purged' | 'failed' | 'locked';
  /** Rows removed per schema-qualified table. */
  deletedRows: Record<string, number>;
  /**
   * Rows whose reference to the account was nulled, per table. Deliberately not
   * folded into {@link deletedRows}: those rows still exist, and this record is
   * the evidence behind a claim about deletion.
   */
  detachedRows: Record<string, number>;
  deletedObjects: number;
  error?: string;
}

export interface PurgeRunSummary {
  /** Accounts examined this run. */
  considered: number;
  purged: number;
  failed: number;
  /** Soft-deleted accounts with no `purge_after`; see {@link UNPINNED_ACCOUNTS_SQL}. */
  unpinned: number;
  outcomes: AccountPurgeOutcome[];
}

/**
 * Hard-deletes the data of accounts whose deletion grace period has expired.
 *
 * This is the half of account deletion that `DELETE /account` promises and does
 * not do. That endpoint stamps `deleted_at` (which revokes access instantly,
 * because `@DeleteDateColumn` hides the row from every repository read) and
 * `purge_after` (the date the data goes). Until this service existed nothing
 * read `purge_after`, so deletion revoked access and kept the data — a
 * difference that matters because both app stores' data-deletion disclosures are
 * statements about the second half, not the first.
 *
 * Four properties, in the order they constrain the design:
 *
 * - **Batched.** Every delete is `ctid IN (… LIMIT n)`, so no statement locks a
 *   million-row table.
 * - **Resumable.** Each batch is its own transaction and commits. A crash, a
 *   restart or a statement timeout costs one batch, not the run.
 * - **Idempotent.** Every statement is scoped by "belongs to this account", so
 *   re-running one simply finds nothing. There is no cursor to corrupt.
 * - **Hypertable-aware.** TimescaleDB targets are expanded to their chunks and
 *   batched per chunk, because `ctid` is only unique within one physical table.
 *
 * The plan itself is derived from the live catalog on every run — see
 * {@link buildPurgePlan} for why that beats both `ON DELETE CASCADE` and a
 * hand-written table list.
 */
@Injectable()
export class AccountPurgeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
    @Optional() @Inject(PURGE_OBJECT_STORE) private readonly objectStore?: PurgeObjectStore,
  ) {
    this.logger.setContext(AccountPurgeService.name);
  }

  /**
   * The plan the next purge would follow, without running it.
   *
   * Exposed because "what would this delete" is a question worth being able to
   * answer before an irreversible job answers it in production — and because the
   * coverage test asserts against it.
   */
  async describePlan(): Promise<PurgePlan> {
    const runner = this.dataSource.createQueryRunner();

    await runner.connect();

    try {
      return await this.buildPlan(runner);
    } finally {
      await runner.release();
    }
  }

  /**
   * Purge every account that is due, up to the configured per-run cap.
   *
   * The cap is what keeps a backlog from turning into one enormous run; the cron
   * simply comes back.
   */
  async purgeDueAccounts(now: Date = new Date()): Promise<PurgeRunSummary> {
    const { maxAccountsPerRun } = config.accountDeletion.purge;

    // Raw SQL, not the repository: `deleted_at` is a @DeleteDateColumn, so every
    // TypeORM read filters out exactly the rows this job exists to find.
    const due = (await this.dataSource.query(DUE_ACCOUNTS_SQL, [now, maxAccountsPerRun])) as Array<{
      id: string;
      deleted_at: Date;
      purge_after: Date;
    }>;

    const [{ count: unpinned }] = (await this.dataSource.query(UNPINNED_ACCOUNTS_SQL)) as Array<{
      count: number;
    }>;

    if (unpinned > 0) {
      this.logger.warn('Soft-deleted accounts without a pinned purge_after are not being purged', {
        count: unpinned,
      });
    }

    const outcomes: AccountPurgeOutcome[] = [];

    for (const account of due) {
      outcomes.push(await this.purgeAccount(account.id, account.deleted_at, account.purge_after));
    }

    return {
      considered: due.length,
      purged: outcomes.filter((outcome) => outcome.status === 'purged').length,
      failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
      unpinned,
      outcomes,
    };
  }

  /**
   * Purge one account.
   *
   * Everything runs on a single dedicated connection so the advisory lock has a
   * session to live in — but *not* inside a transaction, deliberately: the
   * batches have to commit as they go or none of the resumability above is real.
   */
  async purgeAccount(userId: string, requestedAt: Date, purgeAfter: Date): Promise<AccountPurgeOutcome> {
    const runner = this.dataSource.createQueryRunner();

    await runner.connect();

    const deletedRows: Record<string, number> = {};
    const detachedRows: Record<string, number> = {};
    let deletedObjects = 0;

    try {
      const [{ locked }] = (await runner.query(
        `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked`,
        [ADVISORY_LOCK_NAMESPACE, userId],
      )) as Array<{ locked: boolean }>;

      if (!locked) {
        this.logger.warn('Skipping account purge; another worker holds the lock', { userId });

        return { userId, status: 'locked', deletedRows, detachedRows, deletedObjects };
      }

      try {
        await this.markStarted(runner, userId, requestedAt, purgeAfter);

        const plan = await this.buildPlan(runner);

        if (plan.warnings.length > 0) {
          // Refusing to start beats stopping half way: a partial purge leaves an
          // account both unusable and undeleted, and the next run would have to
          // reason about which half happened.
          throw new Error(`Purge plan is not safe to execute: ${plan.warnings.join('; ')}`);
        }

        this.logger.log('Purging account data', {
          userId,
          tables: plan.purgedTables.length,
          steps: plan.steps.length,
        });

        // Objects first. If the process dies between the bytes and the rows, the
        // rows are still there to find the orphaned keys again; the other order
        // loses the pointer and strands the bytes forever.
        deletedObjects = await this.purgeObjects(runner, userId);

        for (const step of plan.steps) {
          const affected = await this.executeStep(runner, step, userId);

          if (affected > 0) {
            // A null step does not delete the row, so it is tallied apart from
            // the deletions. Merging them would inflate the count this record
            // exists to state precisely.
            const tally = step.kind === 'null' ? detachedRows : deletedRows;
            const label = `${step.target.schema}.${step.target.table}`;

            tally[label] = (tally[label] ?? 0) + affected;
          }
        }

        await this.markCompleted(runner, userId, deletedRows, detachedRows, deletedObjects);

        this.logger.log('Account data purged', {
          userId,
          deletedObjects,
          totalRows: Object.values(deletedRows).reduce((sum, count) => sum + count, 0),
        });

        return { userId, status: 'purged', deletedRows, detachedRows, deletedObjects };
      } finally {
        await runner.query(`SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`, [
          ADVISORY_LOCK_NAMESPACE,
          userId,
        ]);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Counts included so a partial purge is legible in the log: which tables
      // were cleared before the failure, and how much of the account is left.
      this.logger.error('Account purge failed', {
        error,
        userId,
        deletedRows,
        detachedRows,
        deletedObjects,
      });

      // Best-effort: if the failure was the database itself, this fails too, and
      // the account is simply picked up again on the next run.
      await this.markFailed(runner, userId, error).catch(() => undefined);

      return { userId, status: 'failed', deletedRows, detachedRows, deletedObjects, error: error.message };
    } finally {
      await runner.release();
    }
  }

  private async buildPlan(runner: QueryRunner): Promise<PurgePlan> {
    const { excludedColumns } = config.accountDeletion.purge;

    const [userColumns, edges] = await Promise.all([
      readUserRefColumns(runner, USERS_TABLE, excludedColumns),
      readFkEdges(runner),
    ]);

    return buildPurgePlan({ userColumns, edges, usersTable: USERS_TABLE });
  }

  private async executeStep(runner: QueryRunner, step: PurgeStep, userId: string): Promise<number> {
    const { batchSize } = config.accountDeletion.purge;

    if (step.kind === 'deleteUser') {
      // One row, and the only statement here that is allowed to fail loudly on a
      // foreign key: if it does, some table holding this account's rows was not
      // in the plan, and that is precisely what must not pass silently.
      return this.runCounting(runner, renderDeleteUser(step.target), [userId]);
    }

    // A hypertable is batched chunk by chunk; an ordinary table expands to itself.
    const physical = await expandToPhysicalTables(runner, step.target);
    let total = 0;

    for (const table of physical) {
      const sql =
        step.kind === 'delete'
          ? renderBatchedDelete(table, step.scope, batchSize)
          : renderBatchedNull(table, step.column, step.scope, batchSize);

      total += await this.runBatched(runner, sql, [userId], step.id);
    }

    return total;
  }

  /** Repeats one bounded statement until it stops finding rows. */
  private async runBatched(
    runner: QueryRunner,
    sql: string,
    parameters: unknown[],
    stepId: string,
  ): Promise<number> {
    const { batchSize } = config.accountDeletion.purge;
    let total = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_STEP; batch += 1) {
      const affected = await this.runCounting(runner, sql, parameters);

      total += affected;

      if (affected < batchSize) {
        return total;
      }
    }

    throw new Error(`Purge step ${stepId} exceeded ${MAX_BATCHES_PER_STEP} batches; aborting`);
  }

  private async runCounting(runner: QueryRunner, sql: string, parameters: unknown[]): Promise<number> {
    const rows = (await runner.query(sql, parameters)) as Array<{ count: number | string }>;

    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Delete the account's objects from the object store.
   *
   * Paged with `LIMIT`/`OFFSET` rather than a keyset because the rows are not
   * being deleted yet — the result set is stable for the length of this loop.
   */
  private async purgeObjects(runner: QueryRunner, userId: string): Promise<number> {
    const [{ present }] = (await runner.query(
      `SELECT (to_regclass('ci.files') IS NOT NULL) AS present`,
    )) as Array<{ present: boolean }>;

    if (!present) {
      return 0;
    }

    if (!this.objectStore) {
      const [{ count }] = (await runner.query(
        `SELECT count(*)::int AS count FROM ci.files WHERE user_id = $1 AND key IS NOT NULL`,
        [userId],
      )) as Array<{ count: number }>;

      if (count > 0) {
        // Loud, because this is the one part of a "purged" account that would
        // otherwise silently survive in a bucket.
        this.logger.warn('No object store wired into the purge; stored file objects will remain', {
          userId,
          objects: count,
        });
      }

      return 0;
    }

    const { batchSize } = config.accountDeletion.purge;
    let offset = 0;
    let deleted = 0;

    for (;;) {
      const page = (await runner.query(PURGEABLE_OBJECTS_SQL, [userId, batchSize, offset])) as Array<{
        bucket: string;
        key: string;
      }>;

      if (page.length === 0) {
        return deleted;
      }

      const byBucket = new Map<string, string[]>();

      for (const object of page) {
        const keys = byBucket.get(object.bucket);

        if (keys) {
          keys.push(object.key);
        } else {
          byBucket.set(object.bucket, [object.key]);
        }
      }

      for (const [bucket, keys] of byBucket) {
        await this.objectStore.deleteObjects(bucket, keys);
        deleted += keys.length;
      }

      offset += page.length;
    }
  }

  private async markStarted(
    runner: QueryRunner,
    userId: string,
    requestedAt: Date,
    purgeAfter: Date,
  ): Promise<void> {
    await runner.query(
      `INSERT INTO ci.account_purges (user_id, requested_at, purge_after, started_at, attempts)
       VALUES ($1, $2, $3, NOW(), 1)
       ON CONFLICT (user_id) DO UPDATE
         SET started_at = NOW(),
             attempts = ci.account_purges.attempts + 1,
             updated_at = NOW()`,
      [userId, requestedAt, purgeAfter],
    );
  }

  private async markCompleted(
    runner: QueryRunner,
    userId: string,
    deletedRows: Record<string, number>,
    detachedRows: Record<string, number>,
    deletedObjects: number,
  ): Promise<void> {
    const updated = (await runner.query(
      `UPDATE ci.account_purges
          SET completed_at = NOW(),
              deleted_rows = $2::jsonb,
              detached_rows = $3::jsonb,
              deleted_objects = $4,
              last_error = NULL,
              next_attempt_after = NULL,
              updated_at = NOW()
        WHERE user_id = $1
      RETURNING user_id`,
      [userId, JSON.stringify(deletedRows), JSON.stringify(detachedRows), deletedObjects],
    )) as unknown[];

    // A purge that cannot record itself has destroyed an account's data and left
    // no evidence the request was honoured, which is the one outcome worse than
    // failing. It happened once already: `ci.account_purges.user_id` matched the
    // user-scoped naming convention, so the purge deleted its own audit row.
    if (updated.length === 0) {
      throw new Error(
        `Purge of ${userId} completed but its audit record is missing — refusing to report success`,
      );
    }
  }

  private async markFailed(runner: QueryRunner, userId: string, error: Error): Promise<void> {
    const { retryBackoffMinutes } = config.accountDeletion.purge;

    await runner.query(
      `UPDATE ci.account_purges
          SET last_error = $2,
              next_attempt_after = NOW() + ($3 || ' minutes')::interval,
              updated_at = NOW()
        WHERE user_id = $1`,
      [userId, error.message.slice(0, 2000), String(retryBackoffMinutes)],
    );
  }
}
