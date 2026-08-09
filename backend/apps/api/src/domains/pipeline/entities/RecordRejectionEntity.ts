import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * An inbound record refused by validation, kept with its raw payload. Mirrors
 * migration 20260809032723_create_pipeline_control_plane.
 *
 * Deliberately a different table from `ci.pipeline_dead_letters`: a dead letter
 * is US failing to process a valid record, a rejection is THEIR record failing
 * validation. Conflating the two is what taught the old importer to
 * log-and-drop, which is how a schema change at a source became weeks of
 * silently missing data that nobody could reconstruct.
 *
 * Keeping {@link payload} verbatim is the point — a fixed parser re-admits the
 * backlog instead of asking the source to re-send data it no longer has.
 */
@Entity({ schema: 'ci', name: 'record_rejections' })
@Index('record_rejections_user_time_idx', ['userId', 'rejectedAt'])
export class RecordRejectionEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  /** NULL when the record was rejected before it could be attributed to a user. */
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  /** Where it came from, e.g. 'google_takeout' | 'browser_extension' | 'imap'. */
  @Column({ type: 'text', name: 'source_kind', nullable: true })
  sourceKind!: string | null;

  /** The record exactly as received. Never trimmed — it is the only copy. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** Which validation failed, specific enough to fix the parser from. */
  @Column({ type: 'text' })
  reason!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'rejected_at' })
  rejectedAt!: Date;
}

export type RecordRejection = Readonly<RecordRejectionEntity>;
