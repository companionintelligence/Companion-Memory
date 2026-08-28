import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** What an apply must do to the person search index. See {@link EntityTypeProposalEntity}. */
export type SearchIndexAction = 'purge_person_index' | 'none';

/** What the trust dial returned for a proposal at detection time. */
export type ProposalAutonomy = 'review' | 'auto';

/** Mirrors `ci.merge_candidates`' vocabulary: the detector only ever writes 'pending'. */
export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

/**
 * One proposal to retype one entity, written by `EntityTypeAuditCron`.
 * See migration 20260821223511 for why this is its own table rather than
 * `ci.merge_candidates` or `ci.actions`.
 *
 * Two fields carry the constraints that make a retype safe, and neither is
 * optional:
 *
 *  - {@link proposedLinkedId} — a type change MOVES the natural key, so a
 *    proposal that named only the type would be a proposal to mint a duplicate
 *    on the next import.
 *  - {@link searchIndexAction} — a retype out of `Person` orphans the person
 *    search index, whose rows must be deleted in the SAME transaction as the
 *    retype or they answer searches forever for a row that is no longer a
 *    person.
 */
@Entity({ schema: 'ci', name: 'entity_type_proposals' })
@Index(['ownerUserId', 'status'])
export class EntityTypeProposalEntity {
  @PrimaryColumn({ type: 'uuid', name: 'entity_type_proposal_id' })
  id!: string;

  @Column({ type: 'uuid', name: 'owner_user_id' })
  ownerUserId!: string;

  @Column({ type: 'uuid', name: 'entity_id' })
  entityId!: string;

  @Column({ type: 'text', name: 'current_entity_type' })
  currentEntityType!: string;

  @Column({ type: 'text', name: 'proposed_entity_type' })
  proposedEntityType!: string;

  @Column({ type: 'uuid', name: 'current_linked_id', nullable: true })
  currentLinkedId!: string | null;

  /** `uuidv5(proposedNaturalKey, IMPORT_NAMESPACE)` — the coordinate a fixed parser mints. */
  @Column({ type: 'uuid', name: 'proposed_linked_id' })
  proposedLinkedId!: string;

  @Column({ type: 'text', name: 'proposed_natural_key' })
  proposedNaturalKey!: string;

  @Column({ type: 'text', name: 'linked_table', nullable: true })
  linkedTable!: string | null;

  /** A row already occupying the proposed coordinate: the apply must merge, not re-key. */
  @Column({ type: 'uuid', name: 'conflicting_entity_id', nullable: true })
  conflictingEntityId!: string | null;

  /** Derived from the TYPE TRANSITION, not from the counts below. */
  @Column({ type: 'text', name: 'search_index_action' })
  searchIndexAction!: SearchIndexAction;

  /** Index rows observed for this entity at detection time, per table. */
  @Column({ type: 'jsonb', name: 'search_index_rows', default: () => `'{}'::jsonb` })
  searchIndexRows!: Record<string, number>;

  @Column({ type: 'double precision', name: 'score' })
  score!: number;

  @Column({ type: 'text', name: 'autonomy' })
  autonomy!: ProposalAutonomy;

  @Column({ type: 'jsonb', name: 'evidence', default: () => `'[]'::jsonb` })
  evidence!: string[];

  @Column({ type: 'text', name: 'status', default: 'pending' })
  status!: ProposalStatus;

  @Column({ type: 'text', name: 'detected_by' })
  detectedBy!: string;

  @Column({ type: 'int', name: 'detector_version' })
  detectorVersion!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
