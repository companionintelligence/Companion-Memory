import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type AuthDenialReason =
  | 'insufficient_scope'
  | 'owner_mismatch'
  | 'revoked'
  | 'expired'
  | 'policy'
  | 'rate_limit';

@Entity({ schema: 'ci', name: 'auth_denials' })
export class AuthDenialEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  actor_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  api_key_id!: string | null;

  @Column({ type: 'text' })
  reason!: AuthDenialReason;

  @Column({ type: 'text', array: true, default: '{}' })
  required_scopes!: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  granted_scopes!: string[];

  @Column({ type: 'text', nullable: true })
  route!: string | null;

  @Column({ type: 'text', nullable: true })
  tool_name!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  extra!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
