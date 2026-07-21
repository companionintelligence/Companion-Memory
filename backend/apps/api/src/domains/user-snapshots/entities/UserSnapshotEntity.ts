import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { DeviceEntity } from '@ci/domains/devices';
import { UserEntity } from '@ci/domains/user';

@Entity({ schema: 'ci', name: 'user_snapshots' })
export class UserSnapshotEntity {
  @PrimaryColumn({ type: 'uuid' })
  snapshot_id!: string;

  @PrimaryColumn({ type: 'timestamptz' })
  observed_at!: Date;

  @PrimaryColumn({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'uuid' })
  device_id!: string;

  @Column({ type: 'uuid' })
  session_id!: string;

  @Column({ type: 'text' })
  producer!: string;

  @Column({ type: 'text' })
  snapshot_kind!: string;

  @Column({ type: 'bigint' })
  monotonic_ms!: number;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  focus_app!: string | null;

  @Column({ type: 'text', nullable: true })
  focus_title!: string | null;

  @Column({ type: 'text', nullable: true })
  cwd!: string | null;

  @Column({ type: 'integer', default: 0 })
  fs_event_count!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity | null;

  @ManyToOne(() => DeviceEntity)
  @JoinColumn({ name: 'device_id', referencedColumnName: 'device_id' })
  device?: DeviceEntity | null;
}
