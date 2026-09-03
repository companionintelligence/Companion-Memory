import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Per-user planning preferences.
 *
 * Every settable column is nullable and NULL means "inherit the shipped
 * default". That is what makes a user with no row here behave exactly as they
 * did before this table existed, and it is why the defaults live in
 * {@link PLANNING_PREFS_DEFAULTS} rather than as column DEFAULTs that could
 * drift from the constants the placer actually uses.
 *
 * Timestamp discipline: `workStart` / `workEnd` are zoneless wall-clock times
 * and TypeORM hydrates them as strings. They are INPUTS to PlanningTimeService,
 * never outputs of it — handing one to `zonedWallTimeToUTC` as though it were
 * an instant is the documented way to break DST in this domain.
 *
 * Timezone is deliberately absent: `ci.users.timezone` is the single source of
 * truth. Trust mode is also absent — it lives at `properties.planner.trust_mode`
 * on the self-Person, where PersonalizationService.decide reads it.
 */
@Entity({ schema: 'ci', name: 'planning_prefs' })
export class PlanningPrefsEntity {
  /** One row per person, so the user id is the key. */
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'time', name: 'work_start', nullable: true })
  workStart!: string | null;

  @Column({ type: 'time', name: 'work_end', nullable: true })
  workEnd!: string | null;

  @Column({ type: 'integer', name: 'default_estimated_minutes', nullable: true })
  defaultEstimatedMinutes!: number | null;

  @Column({ type: 'integer', name: 'flex_days', nullable: true })
  flexDays!: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: PlanningPrefsEntity): PlanningPrefs {
    return {
      userId: entity.userId,
      workStart: entity.workStart,
      workEnd: entity.workEnd,
      defaultEstimatedMinutes: entity.defaultEstimatedMinutes,
      flexDays: entity.flexDays,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type PlanningPrefs = Readonly<PlanningPrefsEntity>;

/**
 * The values a user with no stored preference gets. These mirror the constants
 * the placer already used before this table existed, so an appliance that has
 * never opened a settings page is byte-identical in behaviour.
 */
export const PLANNING_PREFS_DEFAULTS = {
  workStart: '09:00',
  workEnd: '17:00',
  defaultEstimatedMinutes: 30,
  flexDays: 7,
} as const;

/** Preferences with every NULL already collapsed onto its default. */
export interface ResolvedPlanningPrefs {
  workStart: string;
  workEnd: string;
  defaultEstimatedMinutes: number;
  flexDays: number;
}
