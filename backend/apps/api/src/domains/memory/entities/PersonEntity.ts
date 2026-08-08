import { AfterLoad, ChildEntity, Column } from 'typeorm';

import { splitProperties } from '../normalizedProperties';
import { type NormalizedPersonPropertyKey, type PersonProperties, NORMALIZED_PERSON_FIELDS } from '../types';

import { BaseEntity } from './BaseEntity';

/**
 * A person in the knowledge graph, stored as a `Person`-discriminated row in the
 * shared `ci.entities` table. Common columns are inherited from
 * {@link BaseEntity}; this class adds the name fields promoted out of the jsonb
 * `properties` bag plus a few legacy columns still read by `PersonService`.
 */
@ChildEntity('Person')
export class PersonEntity extends BaseEntity {
  // Legacy/deprecated columns kept on PersonEntity (deliberately NOT promoted to
  // BaseEntity). `PersonService` still reads/writes these; remove once its
  // create-idempotency and search paths no longer depend on them.
  @Column({ type: 'text', name: 'search_content', nullable: true })
  searchContent!: string | null;

  @Column({ type: 'text', name: 'linked_table', nullable: true })
  linkedTable!: string | null;

  @Column({ type: 'text', name: 'linked_id', nullable: true })
  linkedId!: string | null;

  @Column({ type: 'timestamptz', name: 'last_accessed', default: () => 'NOW()' })
  lastAccessed!: Date;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  /**
   * Non-NULL marks this row as a merge tombstone pointing at the canonical
   * person (see PersonMergeService). Read paths exclude tombstones.
   */
  @Column({ type: 'uuid', name: 'merged_into_entity_id', nullable: true })
  mergedIntoEntityId!: string | null;

  // Typed identity columns (migration 20260808070235). Canonical for Person/
  // Contact; properties.* kept dual-written during the transition.
  @Column({ type: 'text', name: 'first_name', nullable: true })
  firstName!: string | null;

  @Column({ type: 'text', name: 'middle_name', nullable: true })
  middleName!: string | null;

  @Column({ type: 'text', name: 'last_name', nullable: true })
  lastName!: string | null;

  @Column({ type: 'date', name: 'birth_date', nullable: true })
  birthDate!: string | null;

  /** Nullable in DB; AfterLoad coerces null → false for egress. */
  @Column({ type: 'boolean', name: 'is_self', nullable: true })
  isSelf!: boolean;

  // Normalized attributes projected from `properties` on load (see
  // NORMALIZED_PERSON_FIELDS). Persisted only inside the jsonb bag — these
  // fields are read-through and never mapped to their own columns.
  email!: string | null;

  gender!: string | null;

  address!: string | null;

  streetAddress!: string | null;

  streetAddress2!: string | null;

  city!: string | null;

  region!: string | null;

  country!: string | null;

  postalCode!: string | null;

  @AfterLoad()
  loadPropertiesFromJsonb() {
    const props = this.properties ?? {};
    this.email = (props.email as string) || null;
    // Prefer typed columns; fall back to properties for pre-migration rows.
    this.firstName = this.firstName ?? ((props.first_name as string) || null);
    this.middleName = this.middleName ?? ((props.middle_name as string) || null);
    this.lastName = this.lastName ?? ((props.last_name as string) || null);
    this.birthDate = this.birthDate ?? ((props.birth_date as string) || null);
    if (this.isSelf == null) {
      this.isSelf = props.is_self === true || props.is_self === 'true';
    } else {
      this.isSelf = this.isSelf === true;
    }

    this.gender = (props.gender as string) || null;
    this.address = (props.address as string) || null;
    this.streetAddress = (props.street_address as string) || null;
    this.streetAddress2 = (props.street_address_2 as string) || null;
    this.city = (props.city as string) || null;
    this.region = (props.region as string) || null;
    this.country = (props.country as string) || null;
    this.postalCode = (props.postal_code as string) || null;
  }

  static toEgressType(entity: PersonEntity): Person {
    // Normalized attributes are exposed only as named fields; the egress bag
    // carries source-specific data alone, with the normalized keys stripped.
    const { properties } = splitProperties<NormalizedPersonPropertyKey>(
      entity.properties ?? {},
      NORMALIZED_PERSON_FIELDS,
    );

    return {
      id: entity.id,
      name: entity.name,
      description: entity.description,
      properties,
      email: entity.email,
      firstName: entity.firstName,
      middleName: entity.middleName,
      lastName: entity.lastName,
      birthDate: entity.birthDate,
      isSelf: entity.isSelf,
      isActive: entity.isActive,
      mergedIntoEntityId: entity.mergedIntoEntityId,
      gender: entity.gender,
      address: entity.address,
      streetAddress: entity.streetAddress,
      streetAddress2: entity.streetAddress2,
      city: entity.city,
      region: entity.region,
      country: entity.country,
      postalCode: entity.postalCode,
      searchContent: entity.searchContent,
      linkedTable: entity.linkedTable,
      linkedId: entity.linkedId,
      lastAccessed: entity.lastAccessed,
      userId: entity.userId ?? null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Person = Readonly<Omit<PersonEntity, 'loadPropertiesFromJsonb' | 'properties'>> & {
  // Normalized keys are stripped on egress; only source-specific data remains,
  // and accessing a normalized key here is a compile-time error.
  readonly properties: PersonProperties;
};
