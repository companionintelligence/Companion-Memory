import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { OAuthProviderEntity } from './OAuthProviderEntity';

@Entity('broker_tokens')
@Index(['userId', 'providerId'], { unique: true })
export class BrokerTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  @Index()
  userId!: string;

  @Column({ name: 'provider_id' })
  @Index()
  providerId!: string;

  @Column({ name: 'access_token' })
  accessToken!: string;

  @Column({ name: 'refresh_token', nullable: true })
  refreshToken?: string;

  @Column({ name: 'expires_at', nullable: true })
  expiresAt?: Date;

  @Column('json')
  scopes!: string[];

  @Column({ name: 'token_type', default: 'Bearer' })
  tokenType!: string;

  @Column({ default: true })
  active!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => OAuthProviderEntity)
  @JoinColumn({ name: 'provider_id' })
  provider!: OAuthProviderEntity;
}
