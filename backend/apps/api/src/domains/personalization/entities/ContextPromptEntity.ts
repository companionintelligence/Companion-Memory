import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type {
  ContextPromptSource,
  ContextPromptStatus,
  ContextPromptWritePlan,
  SelectorSpec,
} from '../contextPrompt.types';

@Entity({ schema: 'ci', name: 'context_prompts' })
export class ContextPromptEntity {
  @PrimaryColumn({ type: 'uuid', name: 'context_prompt_id' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text', default: 'pending' })
  status!: ContextPromptStatus;

  @Column({ type: 'jsonb', default: '{}' })
  selector!: SelectorSpec;

  @Column({ type: 'jsonb', default: '{}' })
  source!: ContextPromptSource;

  @Column({ type: 'jsonb', nullable: true })
  response!: unknown | null;

  @Column({ type: 'jsonb', nullable: true, name: 'write_plan' })
  writePlan!: ContextPromptWritePlan | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

export type ContextPrompt = Readonly<ContextPromptEntity>;
