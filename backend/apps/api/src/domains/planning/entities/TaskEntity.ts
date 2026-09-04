import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

import { TASK_STATUSES, type TaskStatus } from '../taskStatus';

// Re-exported so the many callers that already reach for the vocabulary through
// the entity keep working. `../taskStatus` is where it is DEFINED, together with
// the named subsets that stop a filter from silently missing a new status.
export { TASK_STATUSES };
export type { TaskStatus };

/**
 * A unit of planned work.
 *
 * Timestamp discipline (see docs/architecture/planning-roadmap.md):
 * `dueAt` / `completedAt` are instants. `scheduledFor` / `deferUntil` are
 * owner-LOCAL calendar dates and `taskTime` is a zoneless wall-clock time —
 * they are inputs to PlanningTimeService, never outputs of it. TypeORM hydrates
 * `date` and `time` columns as strings, which is deliberate: it keeps them
 * un-confusable with the `Date`-valued instant columns.
 *
 * `proposed` is the trust-dial review inbox: automation surfaced the item but
 * did not auto-add it. Accept promotes to `open`; decline archives.
 */
@Entity({ schema: 'ci', name: 'tasks' })
@Index('idx_tasks_user_status', ['userId', 'status', 'dueAt'])
export class TaskEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'text', default: 'open' })
  status!: TaskStatus;

  @Column({ type: 'int', default: 3 })
  priority!: number;

  @Column({ type: 'uuid', name: 'parent_id', nullable: true })
  parentId!: string | null;

  @Column({ type: 'timestamptz', name: 'due_at', nullable: true })
  dueAt!: Date | null;

  /** Wall-clock `HH:MM:SS`, no zone. */
  @Column({ type: 'time', name: 'task_time', nullable: true })
  taskTime!: string | null;

  /** Owner-local `YYYY-MM-DD`. */
  @Column({ type: 'date', name: 'scheduled_for', nullable: true })
  scheduledFor!: string | null;

  /** Owner-local `YYYY-MM-DD`. */
  @Column({ type: 'date', name: 'defer_until', nullable: true })
  deferUntil!: string | null;

  @Column({ type: 'int', name: 'defer_count', default: 0 })
  deferCount!: number;

  @Column({ type: 'int', name: 'estimated_minutes', nullable: true })
  estimatedMinutes!: number | null;

  @Column({ type: 'int', name: 'actual_minutes', default: 0 })
  actualMinutes!: number;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'text', name: 'source_kind', default: 'manual' })
  sourceKind!: string;

  @Column({ type: 'text', name: 'source_ref', nullable: true })
  sourceRef!: string | null;

  /**
   * KNOWN GAP (as of migration 20260828120000_hbpe_life_forecast): added for
   * HBPE's completed-task token reader (`get_completed_tasks_for_day` in
   * `backend/apps/hbpe/src/ci/hbpe/data_client.py`, which filters on this
   * being non-null and non-'UNKNOWN'), but no writer exists anywhere in this
   * repo — no DTO field, resolver, or service ever sets it. Every row is
   * NULL, so that HBPE query is structurally empty until a writer ships.
   * data_client.py short-circuits the empty scan rather than fixing this;
   * the real fix is a classifier wired into task creation/completion.
   */
  @Column({ type: 'text', name: 'l0_class', nullable: true })
  l0Class!: string | null;

  /** KNOWN GAP: same as `l0Class` above — no writer exists yet. */
  @Column({ type: 'uuid', name: 'l1_cluster_id', nullable: true })
  l1ClusterId!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: TaskEntity): Task {
    return {
      id: entity.id,
      userId: entity.userId,
      title: entity.title,
      description: entity.description,
      notes: entity.notes,
      status: entity.status,
      priority: entity.priority,
      parentId: entity.parentId,
      dueAt: entity.dueAt,
      taskTime: entity.taskTime,
      scheduledFor: entity.scheduledFor,
      deferUntil: entity.deferUntil,
      deferCount: entity.deferCount,
      estimatedMinutes: entity.estimatedMinutes,
      actualMinutes: entity.actualMinutes,
      completedAt: entity.completedAt,
      sourceKind: entity.sourceKind,
      sourceRef: entity.sourceRef,
      l0Class: entity.l0Class,
      l1ClusterId: entity.l1ClusterId,
      metadata: entity.metadata,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Task = Readonly<TaskEntity>;
