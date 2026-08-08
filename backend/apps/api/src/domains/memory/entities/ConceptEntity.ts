import { AfterLoad, ChildEntity, Column } from 'typeorm';

import { BaseEntity } from './BaseEntity';

/**
 * A concept in the knowledge graph, stored as a `Concept`-discriminated row in
 * the shared `ci.entities` table. Common columns are inherited from
 * {@link BaseEntity}; this class adds the jsonb-projected helpers plus a few
 * legacy columns still read by `ConceptService`.
 */
@ChildEntity('Concept')
export class ConceptEntity extends BaseEntity {
  // Legacy/deprecated columns kept on ConceptEntity (deliberately NOT promoted
  // to BaseEntity). `ConceptService` still reads/writes these; remove once its
  // create-idempotency and search paths no longer depend on them.
  @Column({ type: 'text', name: 'search_content', nullable: true })
  searchContent!: string | null;

  @Column({ type: 'text', name: 'linked_table', nullable: true })
  linkedTable!: string | null;

  @Column({ type: 'text', name: 'linked_id', nullable: true })
  linkedId!: string | null;

  @Column({ type: 'timestamptz', name: 'last_accessed', default: () => 'NOW()' })
  lastAccessed!: Date;

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

  static toEgressType(entity: ConceptEntity): Concept {
    return {
      id: entity.id,
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

export type Concept = Readonly<Omit<ConceptEntity, 'loadPropertiesFromJsonb'>>;
