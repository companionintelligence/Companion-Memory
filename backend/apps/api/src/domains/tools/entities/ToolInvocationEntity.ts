import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type ToolInvocationStatus = 'ok' | 'error' | 'denied' | 'confirmed';

@Entity({ schema: 'ci', name: 'tool_invocations' })
export class ToolInvocationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  actor_id!: string | null;

  @Column({ type: 'text' })
  tool_name!: string;

  @Column({ type: 'text', nullable: true })
  provider!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  args!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  @Column({ type: 'text' })
  status!: ToolInvocationStatus;

  @Column({ type: 'boolean', default: false })
  required_confirmation!: boolean;

  @Column({ type: 'uuid', nullable: true })
  confirmed_by!: string | null;

  @Column({ type: 'int', nullable: true })
  latency_ms!: number | null;

  @Column({ type: 'uuid', nullable: true })
  skill_invocation_id!: string | null;

  @Column({ type: 'text', nullable: true })
  error_code!: string | null;

  @Column({ type: 'text', nullable: true })
  error_message!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
