import { Column, CreateDateColumn, Entity, PrimaryColumn, Unique } from 'typeorm';

export type SkillKind = 'deterministic' | 'llm' | 'composite';

/**
 * A single step in a deterministic skill.
 *
 * Each step calls a registered tool by name. Argument values may be:
 *  - A literal JSON value.
 *  - A template string like `"${input.fieldName}"` (resolved from the
 *    invocation input).
 *  - A template string like `"${steps.stepId.output.fieldName}"` (resolved
 *    from a previous step's tool output data).
 *
 * Templates are resolved at runtime by the DeterministicExecutor.
 */
export interface DeterministicStep {
  /** Unique identifier for this step within the skill. */
  id: string;
  /** Name of the tool to call (must appear in `tools_allowed`). */
  tool: string;
  /** Arguments to pass to the tool. Values may contain template expressions. */
  args: Record<string, unknown>;
}

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
  /**
   * Ordered list of steps for `kind='deterministic'` skills.
   * The DeterministicExecutor runs them sequentially, passing outputs
   * between steps via template variable resolution.
   */
  steps?: DeterministicStep[];
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
