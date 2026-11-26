import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

import {
  REMINDER_STATUSES,
  REMINDER_SOURCES,
  type ReminderStatus,
  type ReminderSource,
} from '../reminderStatus';

export { REMINDER_STATUSES, REMINDER_SOURCES };
export type { ReminderStatus, ReminderSource };

/**
 * A due-time notification for a task or a planned block (`ci.events` row).
 *
 * `fireAt` is the sole clock input to `ReminderDispatchService`'s claim query
 * — an instant, resolved once at creation time, never recomputed at read time.
 * `status`/`firedAt` are the claim columns the dispatcher's atomic
 * `UPDATE ... RETURNING` writes; nothing else should ever set `status` to
 * `'fired'`. See the migration's header comment
 * (20260916030813_planning_reminders.sql) for the full design rationale and
 * the deltas from CI-Planning's SQLite source.
 *
 * Delivery columns (20261124044550_reminder_delivery_retry.sql): the claim now
 * writes `status = 'delivering'` with `claimedAt` (the lease start) and an
 * incremented `attempts` (the lease version); the outcome is `'delivered'`
 * with `firedAt` as the receipt, or `'failed'` with `lastError` and, while
 * attempts remain, `nextAttemptAt`. `deliveryMode = 'device'` rows are never
 * claimed: the phone schedules them locally and confirms with `'scheduled'`.
 * `'fired'` survives only on rows claimed before the lease existed.
 */
@Entity({ schema: 'ci', name: 'reminders' })
@Index('idx_reminders_user_due', ['userId', 'status', 'fireAt'])
export class ReminderEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'task_id', nullable: true })
  taskId!: string | null;

  @Column({ type: 'uuid', name: 'block_id', nullable: true })
  blockId!: string | null;

  @Column({ type: 'timestamptz', name: 'fire_at' })
  fireAt!: Date;

  @Column({ type: 'text', default: 'pending' })
  status!: ReminderStatus;

  @Column({ type: 'timestamptz', name: 'fired_at', nullable: true })
  firedAt!: Date | null;

  @Column({ type: 'text', name: 'delivery_mode', default: 'push' })
  deliveryMode!: 'push' | 'device';

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', name: 'claimed_at', nullable: true })
  claimedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'next_attempt_at', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;

  @Column({ type: 'text', default: 'manual' })
  source!: ReminderSource;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  static toEgressType(entity: ReminderEntity): Reminder {
    return {
      id: entity.id,
      userId: entity.userId,
      taskId: entity.taskId,
      blockId: entity.blockId,
      fireAt: entity.fireAt,
      status: entity.status,
      firedAt: entity.firedAt,
      deliveryMode: entity.deliveryMode,
      attempts: entity.attempts,
      claimedAt: entity.claimedAt,
      nextAttemptAt: entity.nextAttemptAt,
      lastError: entity.lastError,
      source: entity.source,
      createdAt: entity.createdAt,
    };
  }
}

export type Reminder = Readonly<ReminderEntity>;
