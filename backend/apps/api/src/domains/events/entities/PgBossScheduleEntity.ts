import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'pgboss', name: 'schedule' })
export class PgBossScheduleEntity {
  @PrimaryColumn({ type: 'text' })
  name!: string;

  @Column({ name: 'cron', type: 'text' })
  cron!: string;

  @Column({ name: 'timezone', type: 'text', nullable: true })
  timezone!: string | null;

  @Column({ name: 'data', type: 'jsonb', nullable: true })
  data!: Record<string, unknown> | null;

  @Column({ name: 'options', type: 'jsonb', nullable: true })
  options!: Record<string, unknown> | null;

  @Column({ name: 'created_on', type: 'timestamptz' })
  createdOn!: Date;

  @Column({ name: 'updated_on', type: 'timestamptz' })
  updatedOn!: Date;
}
