import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import type { TransformMap, FieldMapping, TransformMapMetadata } from '../types/transform';

@Entity({ schema: 'ci', name: 'etl_transform_maps' })
export class TransformMapEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text', name: 'source_type' })
  sourceType!: string;

  @Column({ type: 'text', name: 'target_type' })
  targetType!: string;

  @Column({ type: 'jsonb', default: {} })
  fields!: Record<string, FieldMapping>;

  @Column({ type: 'jsonb', nullable: true })
  transformers!: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: TransformMapMetadata | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: TransformMapEntity): TransformMap {
    return {
      id: entity.id,
      name: entity.name,
      description: entity.description,
      sourceType: entity.sourceType,
      targetType: entity.targetType,
      fields: entity.fields,
      transformers: entity.transformers ?? undefined,
      metadata: entity.metadata ?? undefined,
      enabled: entity.enabled,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
