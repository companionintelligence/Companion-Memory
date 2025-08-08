import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import type { Provider } from '../types';

@Entity({ name: 'providers' })
export class ProviderEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true, name: 'token_host' })
  tokenHost!: string | null;

  @Column({ type: 'text', nullable: true, name: 'token_path' })
  tokenPath!: string | null;

  @Column({ type: 'text', nullable: true, name: 'authorize_path' })
  authorizePath!: string | null;

  @Column({ type: 'text', nullable: true, name: 'api_base_url' })
  apiBaseUrl!: string | null;

  @Column({ type: 'text', nullable: true })
  scopes!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  toProvider(): Provider {
    return {
      id: this.id,
      name: this.name ?? null,
      tokenHost: this.tokenHost ?? null,
      tokenPath: this.tokenPath ?? null,
      authorizePath: this.authorizePath ?? null,
      apiBaseUrl: this.apiBaseUrl ?? null,
      scopes: this.scopes ?? null,
    } satisfies Provider;
  }
}
