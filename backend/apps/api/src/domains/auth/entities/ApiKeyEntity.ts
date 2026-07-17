import { Entity, Column, PrimaryColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import type { ApiKeyProvenance } from '../types';

@Entity({ schema: 'ci', name: 'api_keys' })
export class ApiKeyEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  prefix!: string;

  @Column({ type: 'text' })
  hashed_key!: string;

  @Column({ type: 'text', array: true, default: '{}' })
  scopes!: string[];

  @Column({ type: 'timestamptz', nullable: true })
  expires_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_used_at!: Date | null;

  @Column({ type: 'uuid' })
  user_id!: string;

  /**
   * Who owns this key's lifecycle. `null` = the user created it, and it is theirs
   * to rename and re-scope. `'connect'` = minted by the Companion Memory consent
   * flow, and CI-Hub owns it (rotates, revokes on disconnect/uninstall).
   *
   * Explicit rather than inferred from the `app:` name prefix: names are free-form,
   * so a user could create `app:home-assistant` by hand and have Hub machinery
   * operate on it.
   */
  @Column({ type: 'text', nullable: true })
  managed_by!: ApiKeyProvenance | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  static toEgressType(entity: ApiKeyEntity): ApiKey {
    return {
      id: entity.id,
      name: entity.name,
      prefix: entity.prefix,
      scopes: entity.scopes,
      expires_at: entity.expires_at,
      last_used_at: entity.last_used_at,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
      // Exposed so the UI can tell a Hub-owned connection key from the user's own
      // by the same fact the API enforces on, rather than re-deriving it from the
      // key's name and scopes (which drift apart — a connect key may hold an empty
      // scope set, and a user may legitimately name a key `app:...`).
      managed_by: entity.managed_by,
    };
  }
}

export type ApiKey = Readonly<Omit<ApiKeyEntity, 'user' | 'user_id' | 'hashed_key'>>;
