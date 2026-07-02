import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * Normalized identifier (email / phone) -> graph entity_id lookup. Mirrors
 * migration 20260624140000_create_entity_identifiers.
 *
 * Populated on graph ingest from a Person entity's `properties.emails` /
 * `properties.phones` and queried by the people-linking backfill to resolve a
 * communication's raw participant strings to the entity they belong to.
 *
 * `valueNormalized` uses the SAME rule the importer applies: email = trim +
 * lowercase; phone = last 10 digits of the digit string. The composite
 * (owner_user_id, kind, value_normalized) is unique (the upsert key); there is
 * no surrogate PK, so the unique tuple stands in for one.
 */
@Entity({ schema: 'ci', name: 'entity_identifiers' })
export class EntityIdentifierEntity {
  @PrimaryColumn({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @PrimaryColumn({ type: 'text' })
  kind!: 'email' | 'phone' | 'name';

  @PrimaryColumn({ name: 'value_normalized', type: 'text' })
  valueNormalized!: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  entityId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export type EntityIdentifier = Readonly<EntityIdentifierEntity>;
