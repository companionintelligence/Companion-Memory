import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * One source-profile of a person — the per-source identity fragment layer
 * (the old LifeScope "contacts" collection reborn). A profile is what a single
 * source (google:contacts, discord, communications:participant, files:face,
 * manual, ...) knows about someone; the canonical Person it assembles into is
 * a `ci.entities` row referenced by {@link personEntityId}.
 *
 * (owner_user_id, source_system, remote_key) is the idempotency anchor: the
 * same source re-exporting the same profile updates its row instead of
 * duplicating it. Mirrors migration 20260803210000_create_person_profiles_and_merge.
 */
@Entity({ schema: 'ci', name: 'person_profiles' })
export class PersonProfileEntity {
  @PrimaryColumn({ name: 'profile_id', type: 'uuid' })
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  /** Where the profile came from, e.g. 'google:contacts', 'communications:participant'. */
  @Column({ name: 'source_system', type: 'text' })
  sourceSystem!: string;

  /** Stable per-source key (importer natural key, remote id, kind:value composite). */
  @Column({ name: 'remote_key', type: 'text' })
  remoteKey!: string;

  @Column({ name: 'display_name', type: 'text', nullable: true })
  displayName!: string | null;

  @Column({ type: 'text', nullable: true })
  handle!: string | null;

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl!: string | null;

  /** Normalized emails (same rule as ci.entity_identifiers). */
  @Column({ type: 'text', array: true, default: '{}' })
  emails!: string[];

  /** Normalized phones (same rule as ci.entity_identifiers). */
  @Column({ type: 'text', array: true, default: '{}' })
  phones!: string[];

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  /** The canonical Person (ci.entities row) this profile is assembled into. */
  @Column({ name: 'person_entity_id', type: 'uuid', nullable: true })
  personEntityId!: string | null;

  /** User manually assigned this profile; automation must never move it. */
  @Column({ name: 'pinned_by_user', type: 'boolean', default: false })
  pinnedByUser!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export type PersonProfile = Readonly<PersonProfileEntity>;
