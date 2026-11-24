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

  /** NULL when the sign-in request had no address. */
  @Column({ type: 'text', nullable: true })
  ip!: string | null;

  /** NULL when the sign-in request sent no User-Agent header. */
  @Column({ type: 'text', nullable: true })
  user_agent!: string | null;

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
