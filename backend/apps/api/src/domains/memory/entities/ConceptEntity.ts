import {
  AfterLoad,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

@Entity({ schema: 'ci', name: 'entities' })
export class ConceptEntity {
  @PrimaryColumn('uuid', { name: 'entity_id' })
  id!: string;

  @Column({ type: 'text', name: 'entity_type', default: 'Concept' })
  entityType!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  @Column({ type: 'text', name: 'search_content', nullable: true })
  searchContent!: string | null;

  @Column({ type: 'text', name: 'linked_table', nullable: true })
  linkedTable!: string | null;

  @Column({ type: 'text', name: 'linked_id', nullable: true })
  linkedId!: string | null;

  @Column({ type: 'uuid', name: 'owner_user_id', nullable: true })
  userId?: string | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'owner_user_id' })
  user?: UserEntity;

  // Derived helpers populated from properties JSONB
  type!: string | null;

  category!: string | null;

  aliases!: string[];

  sourceUrl!: string | null;

  sourceData!: Record<string, unknown> | null;

  @AfterLoad()
  loadPropertiesFromJsonb() {
    const props = this.properties ?? {};
    this.type = (props.type as string) || null;
    this.category = (props.category as string) || null;
    this.aliases = Array.isArray(props.aliases) ? (props.aliases as string[]) : [];
    this.sourceUrl = (props.source_url as string) || null;
    this.sourceData = (props.source_data as Record<string, unknown>) || null;
  }

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_accessed', default: () => 'NOW()' })
  lastAccessed!: Date;

  static toEgressType(entity: ConceptEntity): Concept {
    return {
      id: entity.id,
      entityType: entity.entityType,
      name: entity.name,
      description: entity.description,
      properties: entity.properties,
      type: entity.type,
      category: entity.category,
      aliases: entity.aliases,
      sourceUrl: entity.sourceUrl,
      sourceData: entity.sourceData,
      searchContent: entity.searchContent,
      linkedTable: entity.linkedTable,
      linkedId: entity.linkedId,
      userId: entity.userId ?? null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      lastAccessed: entity.lastAccessed,
    };
  }
}

export type Concept = Readonly<Omit<ConceptEntity, 'user' | 'loadPropertiesFromJsonb'>>;
