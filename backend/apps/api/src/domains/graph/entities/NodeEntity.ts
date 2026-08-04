import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'ci', name: 'entities' })
export class NodeEntity {
  @PrimaryColumn({ name: 'entity_id', type: 'uuid' })
  entityId!: string;

  @Column({ name: 'entity_type', type: 'text' })
  entityType!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  userId!: string;

  // External provenance for idempotent ingest (e.g. the importer). The partial
  // unique index entities_linked_uniq(owner_user_id, entity_type, linked_table,
  // linked_id) WHERE linked_table IS NOT NULL is the upsert key.
  @Column({ name: 'linked_table', type: 'text', nullable: true })
  linkedTable!: string | null;

  @Column({ name: 'linked_id', type: 'uuid', nullable: true })
  linkedId!: string | null;

  /**
   * Non-NULL marks this row as a merge tombstone pointing at the canonical
   * entity. A tombstone KEEPS its linked key — that is the whole reason the row
   * survives — so it goes on winning the linked-key lookup above, and every
   * resolution path must follow this pointer rather than return the tombstone.
   *
   * Always exactly one hop: PersonMergeService re-points existing tombstones at
   * the new target when it merges, so chains never form.
   */
  @Column({ name: 'merged_into_entity_id', type: 'uuid', nullable: true })
  mergedIntoEntityId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  static toEgressType(entity: NodeEntity) {
    return {
      entityId: entity.entityId,
      entityType: entity.entityType,
      name: entity.name,
      description: entity.description,
      properties: entity.properties,
      userId: entity.userId,
      linkedTable: entity.linkedTable,
      linkedId: entity.linkedId,
      mergedIntoEntityId: entity.mergedIntoEntityId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Node = Readonly<NodeEntity>;
