import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'facts' })
export class FactEntity {
  @PrimaryColumn('uuid', { name: 'fact_id' })
  fact_id!: string;

  @Column({ type: 'uuid', name: 'fact_owner_id' })
  fact_owner_id!: string;

  @Column({ type: 'jsonb', name: 'fact_statement' })
  fact_statement!: Record<string, unknown>;

  @Column({ type: 'text', name: 'fact_type' })
  fact_type!: string;

  @Column({ type: 'uuid', name: 'original_entity_id', nullable: true })
  original_entity_id!: string | null;

  @Column({ type: 'jsonb', name: 'preserved_relationships', default: '{}' })
  preserved_relationships!: Record<string, unknown>;

  @Column({ type: 'text', name: 'source' })
  source!: string;

  @Column({ type: 'double precision', name: 'confidence_score', default: 1 })
  confidence_score!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'learned_at' })
  learned_at!: Date;

  @Column({ type: 'timestamptz', name: 'archived_at', nullable: true })
  archived_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;

  @Column({ type: 'boolean', name: 'is_current', default: true })
  is_current!: boolean;

  @Column({ type: 'text', name: 'access_level', default: 'private' })
  access_level!: string;
}
