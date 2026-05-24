import { Entity, Column, CreateDateColumn, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'ci', name: 'questions' })
export class QuestionEntity {
  @PrimaryColumn({ type: 'uuid', name: 'question_id' })
  id!: string;

  @Column({ nullable: true, name: 'question_category' })
  category!: string;

  @Column({ name: 'question_text' })
  text!: string;

  @Column({ type: 'text', array: true, nullable: true, name: 'context_tags' })
  contextTags!: string[];

  @Column({ nullable: true, name: 'question_type' })
  questionType!: string;

  @Column({ default: false, name: 'is_seed_question' })
  isSeedQuestion!: boolean;

  @Column({ default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ default: false, name: 'created_by_llm' })
  createdByLlm!: boolean;

  @Column({ nullable: true, name: 'frequency_recommendation' })
  frequencyRecommendation!: string;

  @Column({ type: 'integer', default: 0, name: 'times_asked' })
  timesAsked!: number;

  @Column({ type: 'integer', default: 0, name: 'times_answered' })
  timesAnswered!: number;

  @Column({ type: 'uuid', nullable: true, name: 'is_private_to' })
  isPrivateTo?: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: QuestionEntity) {
    return {
      id: entity.id,
      category: entity.category,
      text: entity.text,
      contextTags: entity.contextTags,
      questionType: entity.questionType,
      isSeedQuestion: entity.isSeedQuestion,
      isActive: entity.isActive,
      createdByLlm: entity.createdByLlm,
      frequencyRecommendation: entity.frequencyRecommendation,
      timesAsked: entity.timesAsked,
      timesAnswered: entity.timesAnswered,
      isPrivateTo: entity.isPrivateTo,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Question = Readonly<QuestionEntity>;
