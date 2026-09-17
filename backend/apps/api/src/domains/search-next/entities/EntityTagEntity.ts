import { Entity, Column, CreateDateColumn, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { TagEntity } from './TagEntity';

@Entity({ schema: 'ci_search', name: 'entity_tag' })
export class EntityTagEntity {
  @PrimaryColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'entity_type', type: 'text' })
  entityType!: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  entityId!: string;

  // Indexed on its own (entity_tag_tag_id_idx): the unique constraint leads
  // with (entity_type, entity_id), so it cannot serve the tag-keyed reads and
  // the rename/delete rewrites. See migration 20260819013739.
  @Index('entity_tag_tag_id_idx')
  @Column({ name: 'tag_id', type: 'uuid' })
  tagId!: string;

  @ManyToOne(() => TagEntity, (tag) => tag.entities)
  @JoinColumn({ name: 'tag_id' })
  tag?: TagEntity;

  // Per-entity dilution weight (20260916025313_planning_tag_taxonomy):
  // 1 = primary, >1 = secondary. UNRELATED to TagEntity.kind, which is a
  // property of the tag itself, not of one entity's application of it. Every
  // row that predates this column defaulted to 1 (primary), so nothing that
  // reads this table without asking about level sees any change.
  @Column({ type: 'smallint', default: 1 })
  level!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  static toEgressType(entity: EntityTagEntity): EntityTag {
    return {
      entityType: entity.entityType,
      entityId: entity.entityId,
      taggedAt: entity.createdAt,
    };
  }
}

// `level` is deliberately excluded here too: nothing reads it through this
// egress type yet (see the taxonomy section of TagService for why it has no
// setter either), and leaving it out keeps this type's shape exactly what it
// was before the column existed.
export type EntityTag = Readonly<
  Omit<EntityTagEntity, 'id' | 'tagId' | 'createdAt' | 'level'> & {
    taggedAt: Date;
  }
>;
