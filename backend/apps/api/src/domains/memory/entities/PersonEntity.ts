import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  AfterLoad,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

@Entity({ schema: 'ci', name: 'entities' })
export class PersonEntity {
  @PrimaryColumn('uuid', { name: 'entity_id' })
  id!: string;

  @Column({ type: 'text', name: 'entity_type', default: 'Person' })
  entityType!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  @Column({ type: 'text', name: 'search_content', nullable: true })
  searchContent!: string | null;

  @Column({ type: 'text', name: 'linked_id', nullable: false })
  linkedId!: string;

  @Column({ type: 'text', name: 'linked_table', nullable: false })
  linkedTable!: string;

  @Column({ type: 'uuid', name: 'owner_user_id', nullable: true })
  userId?: string | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'owner_user_id' })
  user?: UserEntity;

  // Backward compatibility fields - populated from properties JSONB after load
  type!: string | null;

  firstName!: string | null;

  lastName!: string | null;

  gender!: string | null;

  address!: string | null;

  streetAddress!: string | null;

  streetAddress2!: string | null;

  city!: string | null;

  region!: string | null;

  country!: string | null;

  postalCode!: string | null;

  avatarUrl!: string | null;

  externalId!: string | null;

  sourceUrl!: string | null;

  sourceData!: Record<string, unknown> | null;

  @AfterLoad()
  loadPropertiesFromJsonb() {
    this.type = (this.properties?.type as string) || null;
    this.firstName = (this.properties?.first_name as string) || null;
    this.lastName = (this.properties?.last_name as string) || null;
    this.gender = (this.properties?.gender as string) || null;
    this.address = (this.properties?.address as string) || null;
    this.streetAddress = (this.properties?.street_address as string) || null;
    this.streetAddress2 = (this.properties?.street_address_2 as string) || null;
    this.city = (this.properties?.city as string) || null;
    this.region = (this.properties?.region as string) || null;
    this.country = (this.properties?.country as string) || null;
    this.postalCode = (this.properties?.postal_code as string) || null;
    this.avatarUrl = (this.properties?.avatar_url as string) || null;
    this.externalId = (this.properties?.external_id as string) || null;
    this.sourceUrl = (this.properties?.source_url as string) || null;
    this.sourceData = (this.properties?.source_data as Record<string, unknown>) || null;
  }

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_accessed', default: () => 'NOW()' })
  lastAccessed!: Date;

  static toEgressType(entity: PersonEntity): Person {
    return {
      id: entity.id,
      entityType: entity.entityType,
      name: entity.name,
      description: entity.description,
      properties: entity.properties,
      firstName: entity.firstName,
      lastName: entity.lastName,
      type: entity.type,
      gender: entity.gender,
      address: entity.address,
      streetAddress: entity.streetAddress,
      streetAddress2: entity.streetAddress2,
      city: entity.city,
      region: entity.region,
      country: entity.country,
      postalCode: entity.postalCode,
      avatarUrl: entity.avatarUrl,
      externalId: entity.externalId,
      sourceUrl: entity.sourceUrl,
      sourceData: entity.sourceData,
      searchContent: entity.searchContent,
      linkedId: entity.linkedId,
      linkedTable: entity.linkedTable,
      userId: entity.userId || null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      lastAccessed: entity.lastAccessed,
    };
  }
}

export type Person = Readonly<Omit<PersonEntity, 'user' | 'tags' | 'loadPropertiesFromJsonb'>>;
