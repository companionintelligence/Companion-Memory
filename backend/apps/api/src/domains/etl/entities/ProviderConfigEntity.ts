import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import type { ProviderConfig, ProviderSource, OAuthConfig, ProviderTheme } from '../types/provider';

@Entity({ schema: 'ci', name: 'etl_provider_configs' })
export class ProviderConfigEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', name: 'logo_url', nullable: true })
  logoUrl!: string | null;

  @Column({ type: 'jsonb', default: {} })
  theme!: ProviderTheme;

  @Column({ type: 'jsonb', default: [] })
  sources!: ProviderSource[];

  @Column({ type: 'jsonb' })
  auth!: OAuthConfig;

  @Column({ type: 'text', name: 'api_spec_id' })
  apiSpecId!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: ProviderConfigEntity): ProviderConfig {
    return {
      id: entity.id,
      name: entity.name,
      description: entity.description ?? null,
      logoUrl: entity.logoUrl ?? null,
      theme: entity.theme,
      sources: entity.sources,
      auth: entity.auth,
      apiSpecId: entity.apiSpecId,
      enabled: entity.enabled,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
