import {
  Entity,
  Column,
  PrimaryColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

@Entity({ schema: 'ci', name: 'sessions' })
export class SessionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  token!: string;

  @Column({ type: 'text', nullable: true })
  previous_token!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  rotated_at!: Date | null;

  @Column({ type: 'text' })
  ip!: string;

  @Column({ type: 'text' })
  user_agent!: string;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
