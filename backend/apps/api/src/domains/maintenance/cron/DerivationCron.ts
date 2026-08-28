import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { BACKFILL_JOB_PRIORITY, EventService } from '@ci/domains/events';

import { DERIVATION_RUN_QUEUE, DerivationRunRequestEvent } from '../events';

/**
 * 04:40:25 UTC, nightly.
 *
 * Three deliberate choices in one string:
 *
 *  - **04:40** stays clear of the two heavy neighbours the review named — HBPE
 *    nightly at 02:30 and the HBPE bootstrap sweep at 03:00 — and of
 *    `JobMetricsCollector.purgeOnSchedule` at 04:25, the only other job in this
 *    hour.
 *  - **Second 25**, not second 0. Twelve schedules already fire on second 0 of
 *    the minute into one event loop and one 25-connection pool; `@Cron` takes a
 *    seconds field precisely so a new job need not join them. 25 is free at
 *    this minute (10/20/30/40 are claimed by the pre-existing offsets).
 *  - **Nightly**, because nothing reads these aggregates within the hour. A
 *    `COMMUNICATES_WITH` edge that appears tomorrow morning is indistinguishable
 *    to a user from one that appeared at midnight.
 */
export const DERIVATION_CRON = '25 40 4 * * *';

/**
 * The nightly derivation fan-out: one pg-boss job per onboarded user, keyed so
 * it cannot stack.
 *
 * ── Shape ─────────────────────────────────────────────────────────────────
 *
 * Copied deliberately from `PythonFunctionCrons.fanOut`, down to the key
 * layout, because the failure modes are identical: a per-user error must not
 * abort the other users' work, a pass that outlives its own cadence must not be
 * started twice, and a process restart between the tick and the work must not
 * lose the night. `singletonKey: derive:<userId>:<dayKey>` gives all three, and
 * is ENFORCED because {@link DERIVATION_RUN_QUEUE} declares `policy: 'short'`
 * (pg-boss 10's default `standard` stores a key and never checks it).
 *
 * ── Role ──────────────────────────────────────────────────────────────────
 *
 * `role: 'worker'`. The tick itself is one SELECT and N sends, but the queue it
 * feeds is a worker queue, and a fan-out that ran in BOTH processes under a
 * split topology would double every send — the singleton key would absorb it,
 * but relying on a de-duplication policy to undo a mistake the role gate can
 * prevent is the wrong order. Under the single-process `all` topology (every
 * test, `yarn dev`, and the default appliance) `serves('worker')` is true, so
 * this registers exactly as it always would.
 *
 * @see DerivationRunListener - what each of those jobs runs, and why only two legs
 */
@Injectable()
export class DerivationCron {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DerivationCron.name);
  }

  @Cron(DERIVATION_CRON, { name: 'DerivationCron.deriveNightly', role: 'worker' })
  async deriveNightly(): Promise<void> {
    await this.fanOut();
  }

  /** @internal Exposed for the spec; the cron body is a one-line delegate. */
  async fanOut(now: Date = new Date()): Promise<number> {
    const userIds = await this.listOnboardedUserIds();

    if (userIds.length === 0) {
      return 0;
    }

    const dayKey = now.toISOString().slice(0, 10);
    let enqueued = 0;

    for (const userId of userIds) {
      try {
        const jobIds = await this.eventService.send(
          DerivationRunRequestEvent,
          { userId, dayKey, requestedBy: 'DerivationCron' },
          {
            queue: DERIVATION_RUN_QUEUE,
            singletonKey: `derive:${userId}:${dayKey}`,
            // Nobody is waiting on a nightly aggregate; it must never sit in
            // front of interactive work.
            priority: BACKFILL_JOB_PRIORITY,
          },
        );

        if (jobIds.length > 0) {
          enqueued += 1;
        }
      } catch (err) {
        // Per-user, exactly as the Python fan-out does: one user's send failing
        // is not a reason for the other users to lose the night.
        this.logger.error(
          `Failed to enqueue derivation run for user ${userId}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    this.logger.log('Derivation fan-out enqueued', { dayKey, users: userIds.length, enqueued });

    return enqueued;
  }

  /** The same population every other fan-out on this appliance covers. */
  private async listOnboardedUserIds(): Promise<string[]> {
    const rows = (await this.dataSource.query('SELECT id FROM ci.users WHERE onboarded = true')) as Array<{
      id: string;
    }>;

    return rows.map((row) => String(row.id));
  }
}
