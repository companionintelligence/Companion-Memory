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
}

// Built from the same arrays `ReminderDispatchService.test.ts` (suppression
// coverage) and `reminderStatus.ts` export, so the claim query's literal SQL
// and the named vocabulary cannot silently drift apart — see reminderStatus.ts.
const TASK_TERMINAL_SQL = TERMINAL_TASK_STATUSES.map((status) => `'${status}'`).join(', ');
const BLOCK_TERMINAL_SQL = TERMINAL_BLOCK_STATUSES.map((status) => `'${status}'`).join(', ');

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
    }>,
    number,
  ] = await dataSource.query(
    `UPDATE ci.reminders
        SET status = 'fired', fired_at = $2
      WHERE user_id = $1
        AND status = 'pending'
        AND fire_at <= $2
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
      RETURNING id, task_id AS "taskId", block_id AS "blockId", source, fire_at AS "fireAt"`,
    [userId, now],
  );

  return rows;
}

/**
 * Claims due reminders for one user and delivers each — Web Push only. No
 * SSE / in-app channel exists on this appliance (roadmap: "Deliberately not
 * doing" — no realtime layer), so unlike CI-Planning's `deliver()` there is
 * no unconditional first channel here; push is the whole of delivery.
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

    for (const reminder of claimed) {
      try {
        await this.deliver(userId, reminder);
      } catch (err) {
        // Matches CI-Planning's per-row try/catch: the claim already
        // committed (the row is 'fired' regardless), so a delivery failure
        // must not re-throw and cannot un-claim the row — there is no retry
        // for a reminder, only for the push send within it (and there isn't
        // even that; see WebPushService's own fail-soft).
        this.logger.warn('Reminder delivery failed', {
          userId,
          reminderId: reminder.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { fired: claimed.length };
  }

  private async deliver(userId: string, reminder: ClaimedReminder): Promise<void> {
    const context = { userId } as UserServiceContext;
    const payload = await this.contentFor(context, reminder);
    const subscriptions = await this.pushSubscriptions.listForUser(userId);

    for (const subscription of subscriptions) {
      const result = await this.webPush.sendPush(toWebPushSubscription(subscription), payload);

      if (result === 'gone') {
        // I-8 (from the source spec): a 404/410 means the push service itself
        // says this endpoint no longer exists. Left unpruned, a dead
        // subscription would be retried on every future reminder for this
        // user, forever, each one a network call guaranteed to fail.
        await this.pushSubscriptions.remove(subscription.id);
      }
    }
  }

  private async contentFor(
    context: UserServiceContext,
    reminder: ClaimedReminder,
  ): Promise<ReminderPushPayload> {
    const tag = reminderPushTag(reminder.id);

    if (reminder.taskId) {
      const task = await this.taskService.findById(context, reminder.taskId);

      return { title: 'Task reminder', body: task?.title || 'A task is due', url: '/', tag };
    }

    // reminder.blockId is guaranteed set here by the exactly-one-target CHECK.
    const block = await this.calendarEventService.findById(context, reminder.blockId as string);

    return { title: 'Upcoming block', body: block?.title || 'A block is starting', url: '/', tag };
  }
}
