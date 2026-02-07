import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import type { ApiSpec, EndpointSpec, ApiMetadata, RateLimitConfig } from '../types/api-spec';

@Entity({ schema: 'ci', name: 'etl_api_specs' })
export class ApiSpecEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', name: 'base_url' })
  baseUrl!: string;

  @Column({ type: 'text' })
  version!: string;

  @Column({ type: 'jsonb' })
  meta!: ApiMetadata;

  @Column({ type: 'jsonb', default: {} })
  endpoints!: Record<string, EndpointSpec>;

  @Column({ type: 'jsonb', name: 'global_rate_limit', nullable: true })
  globalRateLimit!: RateLimitConfig | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: ApiSpecEntity): ApiSpec {
    return {
      id: entity.id,
      name: entity.name,
      baseUrl: entity.baseUrl,
      version: entity.version,
      meta: entity.meta,
      endpoints: entity.endpoints,
      globalRateLimit: entity.globalRateLimit ?? undefined,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
