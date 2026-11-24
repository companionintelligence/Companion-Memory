import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { CalendarEventService } from '@ci/domains/memory';

import { toWebPushSubscription } from '../entities/PushSubscriptionEntity';
import type { ReminderSource } from '../reminderStatus';
import { TERMINAL_BLOCK_STATUSES, TERMINAL_TASK_STATUSES } from '../reminderStatus';

import { PushSubscriptionService } from './PushSubscriptionService';
import { TaskService } from './TaskService';
import { reminderPushTag, WebPushService, type ReminderPushPayload } from './WebPushService';

export interface ClaimedReminder {
  id: string;
  taskId: string | null;
  blockId: string | null;
  source: ReminderSource;
  fireAt: Date;
  /** The attempt number this claim is (1 on first delivery); also the lease version. */
  attempts: number;
}

/** Delivery attempts per reminder before it stays `'failed'` until a user retries it. */
export const REMINDER_MAX_ATTEMPTS = 5;

/** How long a `'delivering'` claim holds before another tick may reclaim it. */
export const REMINDER_LEASE_MINUTES = 10;

// Built from the same arrays `ReminderDispatchService.test.ts` (suppression
// coverage) and `reminderStatus.ts` export, so the claim query's literal SQL
// and the named vocabulary cannot silently drift apart — see reminderStatus.ts.
const TASK_TERMINAL_SQL = TERMINAL_TASK_STATUSES.map((status) => `'${status}'`).join(', ');
const BLOCK_TERMINAL_SQL = TERMINAL_BLOCK_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * The "this row is ready for a push delivery attempt" predicate, shared by
 * the claim ({@link claimDueReminders}) and the cron's audience query
 * ({@link listUsersWithDueReminders}) so the two cannot drift apart. They did
 * once: the audience asked only for `status = 'pending'`, so a `'failed'` row
 * waiting for its retry, or a `'delivering'` row whose worker died, was never
 * fanned out and the claim that would have picked it up never ran.
 *
 * Three arms, each its own status so the partial index
 * `reminders_dispatch_due_idx` (migration 20261124044550) is provably implied:
 *  - `'pending'`: never attempted, or reset by a user's "Retry delivery";
 *  - `'failed'`: an earlier attempt failed, attempts remain, backoff elapsed;
 *  - `'delivering'`: claimed, but the lease ran out without an outcome being
 *    recorded (the worker crashed or was killed mid-send).
 * `delivery_mode = 'device'` rows are excluded: the phone's own OS fires them.
 *
 * `prefix` qualifies the columns (`'r.'` in a join); `now` is the SQL
 * parameter placeholder holding the tick's clock.
 */
function dispatchableReminderSql(prefix: string, now: string): string {
  const col = (column: string) => `${prefix}${column}`;

  return `${col('delivery_mode')} = 'push'
        AND ${col('fire_at')} <= ${now}
        AND ((${col('status')} = 'pending' AND ${col('attempts')} < ${REMINDER_MAX_ATTEMPTS}
               AND (${col('next_attempt_at')} IS NULL OR ${col('next_attempt_at')} <= ${now}))
          OR (${col('status')} = 'failed' AND ${col('attempts')} < ${REMINDER_MAX_ATTEMPTS}
               AND (${col('next_attempt_at')} IS NULL OR ${col('next_attempt_at')} <= ${now}))
          OR (${col('status')} = 'delivering'
               AND ${col('claimed_at')} < ${now}::timestamptz - interval '${REMINDER_LEASE_MINUTES} minutes'))`;
}

/**
 * The users with at least one reminder ready for a push delivery attempt by
 * `now` — the audience `PlanningJobsCron.enqueueFireReminders` fans out to
 * each minute. "Ready" is {@link dispatchableReminderSql}: due and pending, a
 * failed attempt whose backoff has elapsed, or an expired delivery lease.
 *
 * Appliance-wide by design: the cron used to enqueue one `fire_reminders` job
 * per onboarded user every minute, and each job ran {@link claimDueReminders}
 * for a user who almost never had anything due (1,440 × N pg-boss inserts a
 * day for a few deliveries). This asks the one set-based question first and
 * fans out only to the users it names. The `reminders_dispatch_due_idx
 * (fire_at)` partial index serves it (it replaced `reminders_due_idx`, which
 * covered `status = 'pending'` only); `idx_reminders_user_due` leads with
 * `user_id` and cannot.
 *
 * Joined to `ci.users` so the audience stays the same population every other
 * planning fan-out uses (onboarded, not deleted): the per-user job still runs
 * under a real `userId`, never SYSTEM_USER (roadmap invariant 7).
 */
export async function listUsersWithDueReminders(dataSource: DataSource, now: Date): Promise<string[]> {
  const rows = (await dataSource.query(
    `SELECT DISTINCT r.user_id AS "userId"
       FROM ci.reminders r
       JOIN ci.users u ON u.id = r.user_id
      WHERE ${dispatchableReminderSql('r.', '$1')}
        AND u.onboarded = true
        AND u.deleted_at IS NULL`,
    [now],
  )) as Array<{ userId: string }>;

  return rows.map((row) => String(row.userId));
}

/**
 * Claim every reminder due for `userId` as of `now`, in ONE atomic
 * `UPDATE ... RETURNING`.
 *
 * This is THE load-bearing correctness property of the whole feature — see
 * the migration's header comment for the full argument. In short: Postgres
 * locks every row an UPDATE statement touches for the statement's duration,
 * so two concurrent claims (pg-boss redelivering the same job — it is
 * at-least-once — or two overlapping cron ticks) can never both flip the same
 * row to `'fired'`. The loser's WHERE clause re-evaluates against the
 * winner's already-committed `status = 'fired'` and matches nothing. This
 * property belongs to the STATEMENT; splitting it into a `SELECT` followed by
 * per-row `UPDATE`s (or `find()` + a loop of `save()`) throws it away even if
 * every other line of code stays identical.
 *
 * Since migration 20261124044550 the claim writes `'delivering'` rather than
 * `'fired'`, and the same argument applies to it: the loser re-evaluates
 * against the winner's committed `'delivering'` with a fresh `claimed_at` and
 * matches nothing. The claim is now a LEASE, not a final outcome:
 *  - it stamps `claimed_at` and increments `attempts`; the incremented
 *    `attempts` is the lease version, and `fireDueRemindersForUser` records
 *    the outcome only while status is still `'delivering'` at that version;
 *  - a lease older than {@link REMINDER_LEASE_MINUTES} is reclaimable, so a
 *    worker that died between claim and outcome delays a reminder instead of
 *    losing it;
 *  - a `'failed'` row becomes claimable again once `next_attempt_at` passes,
 *    until {@link REMINDER_MAX_ATTEMPTS} attempts have been made.
 * Legacy `'fired'` rows (claimed before the lease existed) are never
 * reclaimed: whether they were delivered is unknown, and re-sending a
 * possibly-delivered reminder weeks later is worse than not.
 *
 * Suppression is enforced HERE, at claim time, not merely at creation time:
 * a task/block that has since moved to a terminal status is excluded even
 * though nothing re-checked its reminders when the status changed (there is
 * no auto-derivation engine in this milestone to have done so). Reopening the
 * task/block un-suppresses its still-`pending` reminder on the very next tick
 * — no re-sync needed, because the check runs fresh every time.
 *
 * Scoped to one `userId` per call (fanned out by `RemindersCron`, same shape
 * as the other five planning jobs) rather than a single global statement
 * across every user: the atomicity argument above holds either way — it is a
 * property of one UPDATE's WHERE clause, not of how many users it spans — and
 * per-user fan-out is what this codebase's roadmap invariant 7 requires
 * ("planning services never see SYSTEM_USER; only the cron fan-out enqueuer
 * does").
 */
export async function claimDueReminders(
  dataSource: DataSource,
  userId: string,
  now: Date,
): Promise<ClaimedReminder[]> {
  // TypeORM's postgres driver returns `[rows, rowCount]` for a raw
  // UPDATE ... RETURNING (unlike a plain SELECT, which resolves to the rows
  // array directly) — confirmed empirically against this repo's pg driver
  // version, not merely assumed. Destructuring `[rows]` is required; treating
  // the whole tuple as the row array silently reads `.id` off a rowCount and
  // an inner array instead of an actual claimed row.
  const [rows]: [
    Array<{
      id: string;
      taskId: string | null;
      blockId: string | null;
      source: ReminderSource;
      fireAt: Date;
      attempts: number;
    }>,
    number,
  ] = await dataSource.query(
    `UPDATE ci.reminders
        SET status = 'delivering', claimed_at = $2, attempts = attempts + 1, next_attempt_at = NULL
      WHERE user_id = $1
        AND ${dispatchableReminderSql('', '$2')}
        AND (task_id IS NULL OR task_id IN (
              SELECT id FROM ci.tasks
               WHERE user_id = $1 AND status NOT IN (${TASK_TERMINAL_SQL})))
        AND (block_id IS NULL OR block_id IN (
              SELECT event_id FROM ci.events
               WHERE user_id = $1
                 AND COALESCE(status, 'confirmed') NOT IN (${BLOCK_TERMINAL_SQL})
                 AND (task_id IS NULL OR task_id IN (
                       SELECT id FROM ci.tasks
                        WHERE user_id = $1 AND status NOT IN (${TASK_TERMINAL_SQL})))))
      RETURNING id, task_id AS "taskId", block_id AS "blockId", source, fire_at AS "fireAt", attempts`,
    [userId, now],
  );

  return rows;
}

/**
 * How long to wait before the next attempt after attempt number `attempts`
 * failed: 1, 2, 4, then 8 minutes (capped at an hour should the attempt limit
 * ever grow).
 */
export function reminderRetryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** (attempts - 1));
}

/**
 * Claims due reminders for one user and delivers each — Web Push only. No
 * SSE / in-app channel exists on this appliance (roadmap: "Deliberately not
 * doing" — no realtime layer), so unlike CI-Planning's `deliver()` there is
 * no unconditional first channel here; push is the whole of delivery.
 *
 * A reminder counts as `'delivered'` only once at least one push provider
 * ACCEPTED it (`sendPush` returned `'ok'`): that acceptance, stamped into
 * `fired_at`, is the delivery receipt. No subscription, every endpoint gone,
 * or every send failing records `'failed'` with a reason the UI can show.
 */
@Injectable()
export class ReminderDispatchService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly taskService: TaskService,
    private readonly calendarEventService: CalendarEventService,
    private readonly pushSubscriptions: PushSubscriptionService,
    private readonly webPush: WebPushService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ReminderDispatchService.name);
  }

  async fireDueRemindersForUser(userId: string): Promise<{ fired: number }> {
    const claimed = await claimDueReminders(this.dataSource, userId, new Date());

    let fired = 0;

    for (const reminder of claimed) {
      let failure = 'Push delivery could not be completed.';
      let delivered = false;

      try {
        delivered = await this.deliver(userId, reminder);
        if (!delivered) {
          failure = 'No notification endpoint accepted delivery. Enable notifications, then retry.';
        }
      } catch (err) {
        // Matches CI-Planning's per-row try/catch: one reminder's failure must
        // not re-throw and abort the rest of the batch. Unlike CI-Planning the
        // claim is a lease, so the failure is recorded below and retried with
        // backoff rather than lost.
        this.logger.warn('Reminder delivery failed', {
          userId,
          reminderId: reminder.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const retryable = !delivered && reminder.attempts < REMINDER_MAX_ATTEMPTS;

      // Match the lease version: a slow, superseded worker must not overwrite
      // a newer delivery or a cancellation made while the request was in flight.
      await this.dataSource.query(
        `UPDATE ci.reminders SET status = $4, fired_at = $5, last_error = $6,
          next_attempt_at = $7, claimed_at = NULL
         WHERE id = $1 AND user_id = $2 AND status = 'delivering' AND attempts = $3`,
        [
          reminder.id,
          userId,
          reminder.attempts,
          delivered ? 'delivered' : 'failed',
          delivered ? new Date() : null,
          delivered ? null : failure,
          retryable ? new Date(Date.now() + reminderRetryDelayMs(reminder.attempts)) : null,
        ],
      );
      if (delivered) {
        fired += 1;
      }
    }

    return { fired };
  }

  /** True when at least one push provider accepted the notification. */
  private async deliver(userId: string, reminder: ClaimedReminder): Promise<boolean> {
    const context = { userId } as UserServiceContext;
    const payload = await this.contentFor(context, reminder);
    const subscriptions = await this.pushSubscriptions.listForUser(userId);
    let accepted = false;

    for (const subscription of subscriptions) {
      const result = await this.webPush.sendPush(toWebPushSubscription(subscription), payload);

      if (result === 'ok') {
        accepted = true;
      }

      if (result === 'gone') {
        // I-8 (from the source spec): a 404/410 means the push service itself
        // says this endpoint no longer exists. Left unpruned, a dead
        // subscription would be retried on every future reminder for this
        // user, forever, each one a network call guaranteed to fail.
        await this.pushSubscriptions.remove(subscription.id);
      }
    }

    return accepted;
  }

  private async contentFor(
    context: UserServiceContext,
    reminder: ClaimedReminder,
  ): Promise<ReminderPushPayload> {
    const tag = reminderPushTag(reminder.id);

    if (reminder.taskId) {
      const task = await this.taskService.findById(context, reminder.taskId);

      return { title: 'Task reminder', body: task?.title || 'A task is due', url: '/plan', tag };
    }

    // reminder.blockId is guaranteed set here by the exactly-one-target CHECK.
    const block = await this.calendarEventService.findById(context, reminder.blockId as string);

    return { title: 'Upcoming block', body: block?.title || 'A block is starting', url: '/plan', tag };
  }
}
