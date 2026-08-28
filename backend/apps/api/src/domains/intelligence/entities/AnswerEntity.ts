import {
  Entity,
  Column,
  CreateDateColumn,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { UserEntity, type User } from '@ci/domains/user';

import { type AnswerEvidence } from '../types';

import { QuestionEntity, type Question } from './QuestionEntity';

@Entity({ schema: 'ci', name: 'answers' })
export class AnswerEntity {
  @PrimaryColumn({ type: 'uuid', name: 'answer_id' })
  id!: string;

  @Column({ name: 'answer_text' })
  answer!: string;

  /**
   * How sure the writer was, in [0,1]. NULL means "no machine ever scored this":
   * a user-authored answer, an imported one, or an inferred row written before
   * confidence was captured. See domains/llm/inferredAnswerConfidence.ts for the
   * scale, and AnswerService.update for why a user edit clears it.
   */
  @Column({ type: 'double precision', nullable: true, name: 'answer_confidence' })
  answerConfidence!: number | null;

  /**
   * The model's one-line account of what evidence produced an inferred answer,
   * emitted in the same structured generation as the text and the score. Shown
   * beside the confidence so a number is an explanation rather than a shrug.
   */
  @Column({ type: 'text', nullable: true, name: 'answer_rationale' })
  answerRationale!: string | null;

  /**
   * The database rows the model actually cited AND the ones it read and did not
   * use, so `answerRationale` can be checked rather than believed and the
   * retrieval itself can be audited. NULL means no inference ever recorded
   * evidence for this row (a typed answer, an import, or a row written before
   * the column existed) — never "cited nothing", which the speaker gate
   * discards. Written only by AnswerInferenceListener; the REST edit schemas do
   * not accept it.
   */
  @Column({ type: 'jsonb', nullable: true, name: 'answer_evidence' })
  answerEvidence!: AnswerEvidence | null;

  @Column({ default: 'user_input', name: 'answer_source' })
  answerSource!: string;

  @Column({ nullable: true, name: 'answer_method' })
  answerMethod!: string;

  @Column({ type: 'timestamptz', default: () => 'NOW()', name: 'answered_at' })
  answeredAt!: Date;

  @Column({ type: 'jsonb', default: '{}', name: 'session_context' })
  sessionContext!: Record<string, unknown>;

  @Column({ nullable: true, name: 'emotional_state' })
  emotionalState!: string;

  @Column({ nullable: true, name: 'location_context' })
  locationContext!: string;

  @Column({ type: 'text', array: true, nullable: true, name: 'extracted_entities' })
  extractedEntities!: string[];

  @Column({ type: 'double precision', nullable: true, name: 'sentiment_score' })
  sentimentScore!: number;

  @Column({ type: 'double precision', nullable: true, name: 'complexity_score' })
  complexityScore!: number;

  @Column({ default: false, name: 'is_sensitive' })
  isSensitive!: boolean;

  @Column({ default: 'private', name: 'sharing_level' })
  sharingLevel!: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => QuestionEntity)
  @JoinColumn({ name: 'question_id' })
  question?: QuestionEntity;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: AnswerEntity) {
    return {
      id: entity.id,
      answer: entity.answer,
      answerConfidence: entity.answerConfidence,
      answerRationale: entity.answerRationale,
      answerEvidence: entity.answerEvidence,
      answerSource: entity.answerSource,
      answerMethod: entity.answerMethod,
      answeredAt: entity.answeredAt,
      isSensitive: entity.isSensitive,
      sharingLevel: entity.sharingLevel,
      complexityScore: entity.complexityScore,
      sentimentScore: entity.sentimentScore,
      extractedEntities: entity.extractedEntities,
      emotionalState: entity.emotionalState,
      locationContext: entity.locationContext,
      sessionContext: entity.sessionContext,

      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
      question: entity.question ? QuestionEntity.toEgressType(entity.question) : undefined,
    };
  }
}

export type Answer = Readonly<Omit<AnswerEntity, 'user' | 'question' | 'createdAt' | 'updatedAt'>> & {
  user?: User;
  question?: Question;
};
