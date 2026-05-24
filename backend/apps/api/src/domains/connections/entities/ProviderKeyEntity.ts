import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import { encryptedColumnTransformer } from '@ci/common/crypto/field-encryption';

@Entity({ schema: 'ci', name: 'provider_keys' })
export class ProviderKeyEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'provider_id' })
  providerId!: string;

  @Column({ type: 'text', name: 'client_id', transformer: encryptedColumnTransformer })
  clientId!: string;

  @Column({ type: 'text', name: 'client_secret', transformer: encryptedColumnTransformer })
  clientSecret!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: ProviderKeyEntity): ProviderKey {
    return {
      id: entity.id,
      providerId: entity.providerId,
      clientId: entity.clientId,
      clientSecret: entity.clientSecret,
      userId: entity.userId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type ProviderKey = Readonly<ProviderKeyEntity>;
