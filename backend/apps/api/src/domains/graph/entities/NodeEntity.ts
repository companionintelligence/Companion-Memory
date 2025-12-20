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
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Node = Readonly<NodeEntity>;
