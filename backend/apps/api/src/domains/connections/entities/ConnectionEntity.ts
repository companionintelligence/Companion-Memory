import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { encryptedColumnTransformer } from '@ci/common/crypto/field-encryption';
import { UserEntity, type User } from '@ci/domains/user';

import { ProviderEntity, type Provider } from './ProviderEntity';

@Entity({ schema: 'ci', name: 'connections' })
export class ConnectionEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'boolean', default: false })
  active!: boolean;

  @Column({ type: 'text', nullable: true })
  schedule!: string | null;

  @Column({ type: 'text', nullable: true, name: 'access_token', transformer: encryptedColumnTransformer })
  accessToken!: string | null;

  @Column({ type: 'text', nullable: true, name: 'refresh_token', transformer: encryptedColumnTransformer })
  refreshToken!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'token_expiry' })
  tokenExpiry!: Date | null;

  @Column({ type: 'jsonb', nullable: true, name: 'sync_state' })
  syncState!: Record<string, unknown> | null;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'provider_id' })
  providerId!: string;

  @Column({ type: 'jsonb', default: [], name: 'active_endpoints' })
  activeEndpoints!: string[];

  @Column({ type: 'boolean', default: true, name: 'needs_reauth' })
  needsReauth!: boolean;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => ProviderEntity)
  @JoinColumn({ name: 'provider_id' })
  provider?: ProviderEntity;

  @Column({ type: 'text', nullable: true, name: 'external_id' })
  externalId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: ConnectionEntity): Connection {
    return {
      id: entity.id,
      name: entity.name,
      active: entity.active,
      schedule: entity.schedule,
      accessToken: entity.accessToken,
      refreshToken: entity.refreshToken,
      tokenExpiry: entity.tokenExpiry,
      syncState: entity.syncState,
      userId: entity.userId,
      providerId: entity.providerId,
      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
      provider: entity.provider ? ProviderEntity.toEgressType(entity.provider) : undefined,
      activeEndpoints: entity.activeEndpoints,
      needsReauth: entity.needsReauth,
      externalId: entity.externalId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Connection = Readonly<Omit<ConnectionEntity, 'user' | 'provider'>> & {
  user?: User;
  provider?: Provider;
};
