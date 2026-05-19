import { Column, CreateDateColumn, Entity, PrimaryColumn, Unique } from 'typeorm';

export type SkillKind = 'deterministic' | 'llm' | 'composite';

export interface SkillSpec {
  /** Skill kind — drives which executor handles it. */
  kind: SkillKind;
  /** Scopes that an installer must have to install/run this skill. */
  scopes_required?: string[];
  /** JSON-schema-like input/output declarations. */
  input?: Record<string, unknown>;
  output?: { schema?: Record<string, unknown> };
  /** Names of tools (in ci.tool_registry) the LLM kind may invoke. */
  tools_allowed?: string[];
  /** Model routing policy (task class). */
  model_policy?: { task?: string };
  /** Prompts to load as context before LLM execution. */
  context_prompts?: string[];
}

@Entity({ schema: 'ci', name: 'skill_versions' })
@Unique(['skill_id', 'version'])
export class SkillVersionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  skill_id!: string;

  @Column({ type: 'text' })
  version!: string;

  @Column({ type: 'jsonb' })
  spec!: SkillSpec;

  @Column({ type: 'text', nullable: true })
  instructions_md!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'published_at' })
  published_at!: Date;
}
