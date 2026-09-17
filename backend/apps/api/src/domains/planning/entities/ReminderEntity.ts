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
      source: entity.source,
      createdAt: entity.createdAt,
    };
  }
}

export type Reminder = Readonly<ReminderEntity>;
