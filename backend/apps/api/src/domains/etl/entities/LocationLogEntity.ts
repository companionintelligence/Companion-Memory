import { Entity, PrimaryColumn, Column, ManyToOne, CreateDateColumn, JoinColumn } from 'typeorm';

import { UserEntity } from '@ci/domains/user';

import { LocationLog } from '../types';

@Entity('location_logs')
export class LocationLogEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'jsonb', nullable: true })
  content!: Record<string, unknown>;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  toLocationLog(): LocationLog {
    return {
      id: this.id,
      content: this.content,
      user: this.user?.toUser(),
      created_at: this.created_at,
    };
  }
}
