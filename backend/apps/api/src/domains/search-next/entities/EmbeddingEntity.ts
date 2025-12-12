import { Entity, Column, CreateDateColumn, UpdateDateColumn, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'ci_search', name: 'embeddings' })
export class EmbeddingEntity {
  @PrimaryColumn()
  id!: string;

  @Column({ type: 'text', name: 'entity_type' })
  entityType!: string;

  @Column({ type: 'uuid', name: 'entity_id' })
  entityId!: string;

  @Column({
    type: 'text',
    transformer: {
      to: (v: number[]) => `[${v.join(',')}]`,
      from: (v: string) => v.slice(1, -1).split(',').map(Number),
    },
    select: false,
  })
  embedding!: number[];

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: EmbeddingEntity) {
    return {
      id: entity.id,
      entityType: entity.entityType,
      entityId: entity.entityId,
      userId: entity.userId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Embedding = Readonly<Omit<EmbeddingEntity, 'embedding'>>;
