import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

export type NodeType = 'entity' | 'relationship';
export type ChangeType = 'created' | 'updated' | 'archived' | 'deleted' | 'merged';

export interface ChangedField {
  old?: unknown;
  new?: unknown;
}

@Entity({ schema: 'ci', name: 'graph_deltas' })
export class DeltaEntity {
  @PrimaryColumn({ type: 'uuid', name: 'delta_id' })
  deltaId!: string;

  @Column({ type: 'uuid', name: 'entity_id', nullable: true })
  entityId!: string | null;

  @Column({ type: 'uuid', name: 'relationship_id', nullable: true })
  relationshipId!: string | null;

  @Column({ type: 'text', name: 'node_type' })
  nodeType!: NodeType;

  @Column({ type: 'text', name: 'entity_type', nullable: true })
  entityType!: string | null;

  @Column({ type: 'text', name: 'relationship_type', nullable: true })
  relationshipType!: string | null;

  @Column({ type: 'uuid', name: 'from_entity_id', nullable: true })
  fromEntityId!: string | null;

  @Column({ type: 'uuid', name: 'to_entity_id', nullable: true })
  toEntityId!: string | null;

  @Column({ type: 'text', name: 'change_type' })
  changeType!: ChangeType;

  @Column({ type: 'jsonb', name: 'changed_fields', default: '{}' })
  changedFields!: Record<string, ChangedField>;

  @Column({ type: 'text', name: 'change_source', nullable: true })
  changeSource!: string | null;

  @Column({ type: 'text', name: 'change_reason', nullable: true })
  changeReason!: string | null;

  @Column({ type: 'uuid', name: 'summary_id', nullable: true })
  summaryId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'changed_at' })
  changedAt!: Date;

  @Column({ type: 'uuid', name: 'changed_by_user_id', nullable: true })
  changedByUserId!: string | null;

  @Column({ type: 'uuid', name: 'owner_user_id', nullable: true })
  ownerUserId!: string | null;

  static toEgressType(entity: DeltaEntity): Delta {
    return {
      deltaId: entity.deltaId,
      entityId: entity.entityId,
      relationshipId: entity.relationshipId,
      nodeType: entity.nodeType,
      entityType: entity.entityType,
      relationshipType: entity.relationshipType,
      fromEntityId: entity.fromEntityId,
      toEntityId: entity.toEntityId,
      changeType: entity.changeType,
      changedFields: entity.changedFields,
      changeSource: entity.changeSource,
      changeReason: entity.changeReason,
      summaryId: entity.summaryId,
      changedAt: entity.changedAt,
      changedByUserId: entity.changedByUserId,
      ownerUserId: entity.ownerUserId,
    };
  }
}

export type Delta = Readonly<{
  deltaId: string;
  entityId: string | null;
  relationshipId: string | null;
  nodeType: NodeType;
  entityType: string | null;
  relationshipType: string | null;
  fromEntityId: string | null;
  toEntityId: string | null;
  changeType: ChangeType;
  changedFields: Record<string, ChangedField>;
  changeSource: string | null;
  changeReason: string | null;
  summaryId: string | null;
  changedAt: Date;
  changedByUserId: string | null;
  ownerUserId: string | null;
}>;
