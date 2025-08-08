import { Entity, PrimaryColumn, Column, ManyToOne, CreateDateColumn, JoinColumn } from 'typeorm';

import { UserEntity } from '@ci/domains/user';

import { ApiLog } from '../types';

import { ConnectionEntity } from './ConnectionEntity';

@Entity('api_logs')
export class ApiLogEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', nullable: true })
  content!: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity | null;

  @ManyToOne(() => ConnectionEntity)
  @JoinColumn({ name: 'connection_id' })
  connection?: ConnectionEntity | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  toApiLog(): ApiLog {
    return {
      id: this.id,
      content: this.content,
      user: this.user?.toUser(),
      connection: this.connection?.toConnection(),
      created_at: this.created_at,
    };
  }
}
