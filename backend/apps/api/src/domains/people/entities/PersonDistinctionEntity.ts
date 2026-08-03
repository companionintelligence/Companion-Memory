import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * A sticky user correction: a fact the promotion pipeline must never undo
 * (the old LifeScope `removed_contact_ids` idea). Two shapes:
 *
 * - person/person — {@link entityIdA} + {@link entityIdB} set (a < b),
 *   {@link profileId} NULL: "these two people are NOT the same" (from a
 *   rejected duplicate suggestion). Blocks auto-merge of the pair.
 * - profile/person — {@link profileId} + {@link entityIdA} set,
 *   {@link entityIdB} NULL: "this profile does NOT belong to this person"
 *   (from a user detaching a profile). Blocks re-attaching the profile.
 *
 * Mirrors migration 20260803210000_create_person_profiles_and_merge.
 */
@Entity({ schema: 'ci', name: 'person_distinctions' })
export class PersonDistinctionEntity {
  @PrimaryColumn({ name: 'distinction_id', type: 'uuid' })
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @Column({ name: 'entity_id_a', type: 'uuid' })
  entityIdA!: string;

  @Column({ name: 'entity_id_b', type: 'uuid', nullable: true })
  entityIdB!: string | null;

  @Column({ name: 'profile_id', type: 'uuid', nullable: true })
  profileId!: string | null;

  @Column({ type: 'text', default: 'user' })
  reason!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export type PersonDistinction = Readonly<PersonDistinctionEntity>;
