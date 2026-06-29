import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import config from '@ci/configuration';

export interface ProviderEndpoint {
  name: string;
  description: string;
  iterationType: string;
  TTL?: number;
}

export interface ProviderTheme {
  backgroundColor: string | null;
  borderColor: string | null;
}

@Entity({ schema: 'ci', name: 'providers' })
export class ProviderEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: [] })
  endpoints!: ProviderEndpoint[];

  @Column({ type: 'text', name: 'logo_url', nullable: true })
  logoUrl!: string | null;

  @Column({ type: 'text', name: 'auth_type', nullable: true })
  authType!: string | null;

  @Column({ type: 'text', name: 'openid_key_link', nullable: true })
  openidKeyLink!: string | null;

  @Column({ type: 'text', name: 'app_setup_url', nullable: true })
  appSetupUrl!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  theme!: ProviderTheme;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'boolean', name: 'local_only', default: false })
  localOnly!: boolean;

  static toEgressType(entity: ProviderEntity): Provider {
    return {
      id: entity.id,
      name: entity.name ?? null,
      description: entity.description ?? null,
      endpoints: entity.endpoints,
      logoUrl: entity.logoUrl ?? null,
      theme: {
        backgroundColor: entity.theme.backgroundColor ?? null,
        borderColor: entity.theme.borderColor ?? null,
      },
      authType: entity.authType ?? null,
      openidKeyLink: entity.openidKeyLink ?? null,
      appSetupUrl: entity.appSetupUrl ?? null,
      localOnly:
        entity.authType === 'oauth2' && (!config.ciPortal.deviceId || !config.ciPortal.apiKey)
          ? true
          : (entity.localOnly ?? false),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Provider = Readonly<ProviderEntity>;
