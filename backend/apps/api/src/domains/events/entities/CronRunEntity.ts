import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Durable last-fire time for a Nest `@Cron` registration key.
 *
 * SchedulerRegistry only keeps `lastDate()` for the current process — after a
 * restart the Jobs page would show "—" for every schedule. This row is what
 * survives the API going away for two weeks.
 */
@Entity({ schema: 'ci', name: 'cron_runs' })
export class CronRunEntity {
  @PrimaryColumn({ name: 'name', type: 'text' })
  name!: string;

  /** Stamped BEFORE the body, so it is the last *attempt* — a throwing tick counts. */
  @Column({ name: 'last_run_at', type: 'timestamptz' })
  lastRunAt!: Date;

  /** Stamped after the body returns without throwing. Null until one tick completes. */
  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt!: Date | null;
}
