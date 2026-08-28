import { Entity, Column, CreateDateColumn, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'ci', name: 'questions' })
export class QuestionEntity {
  @PrimaryColumn({ type: 'uuid', name: 'question_id' })
  id!: string;

  @Column({ nullable: true, name: 'question_category' })
  category!: string;

  /**
   * Which half of the catalogue this question belongs to: 'factual' settles a
   * fact, 'preference' records a taste, 'narrative' asks for a story. Selection
   * orders by this so the appliance asks the answerable questions first — see
   * TIER_RANK_SQL in QuestionService. NULL means a pre-catalogue question.
   */
  @Column({ type: 'text', nullable: true, name: 'answer_tier' })
  answerTier?: string | null;

  @Column({ name: 'question_text' })
  text!: string;

  /**
   * Stable, database-independent name for a curated question — the thing
   * outside code points at instead of `question_id`, which `gen_uuid_v7()`
   * mints fresh on every appliance. NULL for the vast majority of catalogue
   * rows: a key is for questions some surface depends on by name (the Self
   * page's "Life details" grid), not a second id for everything.
   *
   * Written by seed migrations only. No API accepts one, so an ordinary edit
   * cannot rename or steal a key; a fork inherits its origin's key, which is
   * what keeps a curated surface working for whoever edited the question.
   */
  @Column({ type: 'text', nullable: true, name: 'question_key' })
  key?: string | null;

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

  /**
   * Set when this row is one user's private copy of a shared catalogue row,
   * minted because a shared row is read-only to an ordinary caller. The origin
   * is filtered out of that user's selections so the copy replaces it rather
   * than sitting beside it — see `excludeForkedOriginsSql`.
   */
  @Column({ type: 'uuid', nullable: true, name: 'forked_from_question_id' })
  forkedFromQuestionId?: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: QuestionEntity) {
    return {
      id: entity.id,
      key: entity.key ?? null,
      category: entity.category,
      answerTier: entity.answerTier ?? null,
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
      forkedFromQuestionId: entity.forkedFromQuestionId ?? null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Question = Readonly<QuestionEntity>;
