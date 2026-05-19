import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type SkillInvocationStatus = 'ok' | 'error' | 'denied';

@Entity({ schema: 'ci', name: 'skill_invocations' })
export class SkillInvocationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  skill_version_id!: string;

  @Column({ type: 'uuid' })
  actor_id!: string;

  @Column({ type: 'jsonb', nullable: true })
  input!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  output!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  tool_trace!: Record<string, unknown> | null;

  @Column({ type: 'int', nullable: true })
  latency_ms!: number | null;

  @Column({ type: 'text' })
  status!: SkillInvocationStatus;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
