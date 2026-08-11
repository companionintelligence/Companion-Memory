import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export type EntityMutationAggregateKind = 'entity' | 'relationship';
export type EntityMutationOp = 'insert' | 'update' | 'delete' | 'merge';

/**
 * App-written append-only trail for CTI/graph mutations (#1941).
 * Not populated by DB triggers — services call {@link EntityMutationService.record}.
 */
@Entity({ schema: 'ci', name: 'entity_mutations' })
@Index('entity_mutations_user_occurred_idx', ['userId', 'occurredAt'])
@Index('entity_mutations_aggregate_idx', ['aggregateKind', 'aggregateId', 'occurredAt'])
export class EntityMutationEntity {
  @PrimaryColumn('uuid', { name: 'mutation_id' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;

  @Column({ type: 'text', name: 'aggregate_kind' })
  aggregateKind!: EntityMutationAggregateKind;

  @Column({ type: 'uuid', name: 'aggregate_id' })
  aggregateId!: string;

  @Column({ type: 'text', name: 'entity_type', nullable: true })
  entityType!: string | null;

  @Column({ type: 'text', name: 'relationship_type', nullable: true })
  relationshipType!: string | null;

  @Column({ type: 'text' })
  op!: EntityMutationOp;

  @Column({ type: 'jsonb', default: {} })
  payload!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: {} })
  causation!: Record<string, unknown>;
}
