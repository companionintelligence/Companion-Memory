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
   * TIER_RANK_SQL in questionOrder.ts. NULL means a pre-catalogue question.
   */
  @Column({ type: 'text', nullable: true, name: 'answer_tier' })
  answerTier?: string | null;

  /**
   * Where a seeded catalogue question sits in the seed migrations, in the order
   * they list it. The inference rotation takes the catalogue round-robin across
   * categories in this order (questionOrder.ts), because `question_id` order is
   * a different shuffle on every appliance. NULL for anything no seed migration
   * wrote — including a fork, which `forkSharedQuestion` deliberately leaves
   * without one.
   *
   * Written by migrations only; nothing in the app sets or reads it through
   * the repository.
   */
  @Column({ type: 'integer', nullable: true, name: 'seed_position' })
  seedPosition?: number | null;

  /**
   * Whether the appliance may try to answer this question from the owner's own
   * corpus. 'traceable' (the column default) means it may; 'hand_entry' means
   * only the owner can say — a diagnosis, a body measurement, a sexual
   * orientation — so nothing may write one on their behalf. Both inference
   * selectors skip a 'hand_entry' row. See 20260825074747_add_question_evidence_class
   * and 20260825185434_sensitive_questions_hand_entry.
   *
   * Classified by those migrations, by text, so nothing in the app decides it and
   * no API accepts it. The one thing the app does is CARRY it: `forkSharedQuestion`
   * copies it from the origin, because the fork hides the origin from the
   * selectors and, left to the column default, would turn a 'hand_entry' question
   * back into a 'traceable' one the moment its owner rewords it.
   *
   * Not in `toEgressType`, so neither REST nor GraphQL exposes it.
   */
  @Column({ type: 'text', default: 'traceable', name: 'evidence_class' })
  evidenceClass?: 'traceable' | 'hand_entry';

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
