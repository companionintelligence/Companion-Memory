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
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Node = Readonly<NodeEntity>;
