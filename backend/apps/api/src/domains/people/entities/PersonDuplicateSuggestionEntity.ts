import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

/**
 * A weak-signal (name-only) duplicate candidate pair. Never auto-merged:
 * a user confirms (mergePersons -> 'accepted') or rejects (-> 'rejected',
 * which also writes a person_distinctions pair row so the pair is never
 * suggested or auto-merged again). 'stale' marks suggestions invalidated by
 * a merge that consumed one endpoint.
 *
 * (entity_id_a, entity_id_b) is stored ordered (a < b) so the pair is unique
 * regardless of discovery order. Mirrors migration
 * 20260803210000_create_person_profiles_and_merge.
 */
@Entity({ schema: 'ci', name: 'person_duplicate_suggestions' })
export class PersonDuplicateSuggestionEntity {
  @PrimaryColumn({ name: 'suggestion_id', type: 'uuid' })
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @Column({ name: 'entity_id_a', type: 'uuid' })
  entityIdA!: string;

  @Column({ name: 'entity_id_b', type: 'uuid' })
  entityIdB!: string;

  @Column({ type: 'real', default: 0.5 })
  confidence!: number;

  /** What matched, for display/audit: e.g. {"kind":"name","value":"liam broza"}. */
  @Column({ type: 'jsonb', default: '{}' })
  signals!: Record<string, unknown>;

  @Column({ type: 'text', default: 'pending' })
  status!: SuggestionStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export type PersonDuplicateSuggestion = Readonly<PersonDuplicateSuggestionEntity>;
