import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

/**
 * One activity-perception snapshot streamed by a paired applet (the `vizier`
 * engine's wake/snapshot/watch output). Stored verbatim; the structured
 * `payload` keeps the full observation while the promoted columns
 * (focus_app/title, cwd, fs_event_count) make the common signals queryable.
 */
@Entity({ schema: 'ci', name: 'user_snapshots' })
export class UserSnapshotEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'uuid' })
  device_id!: string;

  @Column({ type: 'text' })
  session_id!: string;

  @Column({ type: 'text' })
  snapshot_kind!: string;

  @Column({ type: 'timestamptz' })
  observed_at!: Date;

  // i64 milliseconds from the applet — stored as bigint (TypeORM maps to string).
  @Column({ type: 'bigint' })
  monotonic_ms!: string;

  @Column({ type: 'jsonb', default: '{}' })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  focus_app?: string | null;

  @Column({ type: 'text', nullable: true })
  focus_title?: string | null;

  @Column({ type: 'text', nullable: true })
  cwd?: string | null;

  @Column({ type: 'int', default: 0 })
  fs_event_count!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export type UserSnapshot = Readonly<UserSnapshotEntity>;
