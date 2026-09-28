import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import {
  type AutoMergeResult,
  DETERMINISTIC_MERGE_CRON,
  MergeCandidateService,
} from '../services/MergeCandidateService';

/**
 * xx:17:53 UTC, every hour.
 *
 *  - **Hourly**, because the backlog it drains arrives in bulk: a
 *    `clean.duplicate_detect` re-sweep (nightly enrichment window) can file
 *    ~2k deterministic pairs at once, and at roughly a second per merge that
 *    is more than one tick's budget. An hourly cadence clears it within a few
 *    hours of the sweep without a long-running job.
 *  - **Minute 17**, clear of the top-of-hour pile-up (HBPE hourly summaries at
 *    :05, dossier refresh at :12, the pipeline tick every five minutes) and of
 *    `StagedUploadPurgeCron` at xx:17:00.
 *  - **Second 53**: `common/schedule/__tests__/cronSecondOffsets.test.ts`
 *    listed 53 as free; this schedule claims it there.
 */
export const DETERMINISTIC_PERSON_MERGE_CRON = '53 17 * * * *';

/** Per-user wall-clock budget for one tick. */
export const PER_USER_BUDGET_MS = 10 * 60_000;

/** Whole-tick cap, so a tick can never run into the next one. */
export const TICK_BUDGET_MS = 45 * 60_000;

/**
 * Folds pending person pairs that share a deterministic identity — a mailbox,
 * an adjudicated exact phone, or an exact LinkedIn profile URL — for every
 * onboarded user.
 *
 * `clean.duplicate_detect` only PROPOSES; before this job the only thing that
 * folded its deterministic tier was the People page's review query, which
 * drained 100 rows per page load and re-selected the same failing rows
 * forever. This is the unattended drain. Every merge still goes through
 * `MergeCandidateService.autoMergeDeterministicPairs`, which re-adjudicates
 * the live rows first and demotes a pair that no longer qualifies to the
 * review queue rather than merging it on stale evidence.
 *
 * ## The phone tier's live re-check
 *
 * A phone-only pair is re-graded by `PhoneHolders.adjudicate`
 * (`memory/utils/phoneIdentity.ts`) on the endpoints as they are now,
 * against the owner's whole phone corpus read once per drain and kept in
 * step after every merge: a rename to another given name, a number that has
 * since become over-common or gained a second real identity on its line, or
 * a self endpoint each demote the pair to a labelled review row instead of
 * merging it. A phone pair is never folded into the self Person.
 *
 * ## Kill switch
 *
 * Disabling this schedule on the Jobs page stops it, AND stops the People
 * page's on-read fold of the phone and profile-URL tiers
 * (`PersonResolver.mergeCandidates` reads the same setting), which then
 * shows those pairs for review instead. Email pairs still fold on read.
 *
 * ## Role
 *
 * `role: 'worker'` like the other maintenance sweeps, and `exclusive`: the
 * drain carries no guard of its own, and two overlapping ticks would only
 * contend for the same rows' locks.
 */
@Injectable()
export class DeterministicPersonMergeCron {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mergeCandidateService: MergeCandidateService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DeterministicPersonMergeCron.name);
  }

  @Cron(DETERMINISTIC_PERSON_MERGE_CRON, {
    name: DETERMINISTIC_MERGE_CRON,
    role: 'worker',
    exclusive: true,
  })
  async drain(): Promise<void> {
    await this.sweep();
  }

  /** @internal Exposed for the spec; the cron body is a one-line delegate. */
  async sweep(budgets: { perUserMs?: number; tickMs?: number } = {}): Promise<AutoMergeResult> {
    const perUserMs = budgets.perUserMs ?? PER_USER_BUDGET_MS;
    const tickDeadline = Date.now() + (budgets.tickMs ?? TICK_BUDGET_MS);
    const totals: AutoMergeResult = { merged: 0, skipped: 0, demoted: 0, considered: 0 };
    const userIds = await this.listOnboardedUserIds();
    let users = 0;

    for (const userId of userIds) {
      const remaining = tickDeadline - Date.now();

      if (remaining <= 0) {
        this.logger.warn('Deterministic person merge tick ran out of time; the rest wait for the next tick', {
          usersLeft: userIds.length - users,
        });
        break;
      }

      users += 1;

      try {
        const result = await this.mergeCandidateService.autoMergeDeterministicPairs(
          { userId },
          { budgetMs: Math.min(perUserMs, remaining) },
        );

        totals.merged += result.merged;
        totals.skipped += result.skipped;
        totals.demoted += result.demoted;
        totals.considered += result.considered;
      } catch (error) {
        // Per-user, like every other fan-out here: one account's failed drain
        // is not a reason for the rest to wait an hour.
        this.logger.error('Deterministic person merge failed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log('Deterministic person merge drain complete', { users, ...totals });

    return totals;
  }

  /** The same population every other fan-out on this appliance covers. */
  private async listOnboardedUserIds(): Promise<string[]> {
    const rows = (await this.dataSource.query('SELECT id FROM ci.users WHERE onboarded = true')) as Array<{
      id: string;
    }>;

    return rows.map((row) => String(row.id));
  }
}
