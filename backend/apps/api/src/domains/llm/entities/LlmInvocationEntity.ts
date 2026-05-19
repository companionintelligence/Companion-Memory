import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { LlmTask } from '../providers/LlmProvider';

export type LlmInvocationStatus = 'ok' | 'error' | 'aborted';

@Entity({ schema: 'ci', name: 'llm_invocations' })
export class LlmInvocationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  actor_id!: string | null;

  @Column({ type: 'text' })
  task!: LlmTask;

  @Column({ type: 'text' })
  provider!: string;

  @Column({ type: 'text' })
  model!: string;

  @Column({ type: 'int', nullable: true })
  input_tokens!: number | null;

  @Column({ type: 'int', nullable: true })
  output_tokens!: number | null;

  @Column({ type: 'int', nullable: true })
  latency_ms!: number | null;

  @Column({ type: 'bigint', nullable: true })
  cost_usd_micro!: string | null;

  @Column({ type: 'boolean', default: false })
  redacted!: boolean;

  @Column({ type: 'uuid', nullable: true })
  skill_invocation_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  tool_invocation_id!: string | null;

  @Column({ type: 'text' })
  status!: LlmInvocationStatus;

  @Column({ type: 'text', nullable: true })
  error_kind!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
