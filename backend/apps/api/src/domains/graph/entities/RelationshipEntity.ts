import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'ci', name: 'relationships' })
export class RelationshipEntity {
  @PrimaryColumn({ name: 'relationship_id', type: 'uuid' })
  id!: string;

  @Column({ name: 'from_entity_id', type: 'uuid' })
  fromNodeId!: string;

  @Column({ name: 'from_entity_type', type: 'text' })
  fromNodeType!: string;

  @Column({ name: 'to_entity_id', type: 'uuid' })
  toNodeId!: string;

  @Column({ name: 'to_entity_type', type: 'text' })
  toNodeType!: string;

  @Column({ name: 'relationship_type', type: 'text' })
  type!: string;

  @Column({ type: 'double precision', default: 1.0 })
  strength!: number;

  @Column({ name: 'is_bidirectional', type: 'boolean', default: false })
  isBidirectional!: boolean;

  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate!: Date | null;

  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate!: Date | null;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  static toEgressType(entity: RelationshipEntity): Relationship {
    return {
      id: entity.id,
      fromNodeId: entity.fromNodeId,
      fromNodeType: entity.fromNodeType,
      toNodeId: entity.toNodeId,
      toNodeType: entity.toNodeType,
      type: entity.type,
      strength: entity.strength,
      isBidirectional: entity.isBidirectional,
      startDate: entity.startDate,
      endDate: entity.endDate,
      userId: entity.userId,
      properties: entity.properties,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Relationship = Readonly<RelationshipEntity>;
