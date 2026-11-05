import type { LoggerService } from '@ci/common/logging';

export interface FanOutOutcome {
  /** How many users were offered work. */
  users: number;
  /** How many `enqueue` calls reported a job actually queued. */
  enqueued: number;
  /** How many `enqueue` calls threw; each is logged and the loop goes on. */
  failed: number;
}

/**
 * Offer one unit of work to each user, one user's failure never costing the
 * rest theirs.
 *
 * Every per-user fan-out cron had this loop — list users, for each `send`
 * inside a try/catch, count, log — and one of them had lost the try/catch,
 * so a single failed send aborted the remaining users of every schedule that
 * shared it. `enqueue` answers whether a job was actually queued (a singleton
 * key or a per-user preference can say no without failing), which is the
 * count the caller's summary line wants.
 */
export async function fanOutPerUser(
  userIds: readonly string[],
  enqueue: (userId: string) => Promise<boolean>,
  { logger, label }: { logger: LoggerService; label: string },
): Promise<FanOutOutcome> {
  let enqueued = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      if (await enqueue(userId)) {
        enqueued += 1;
      }
    } catch (err) {
      failed += 1;
      logger.error(
        `Failed to enqueue ${label} for user ${userId}`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  return { users: userIds.length, enqueued, failed };
}
