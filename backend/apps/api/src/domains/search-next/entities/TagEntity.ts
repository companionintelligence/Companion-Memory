import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  UpdateDateColumn,
  DeleteDateColumn,
  Unique,
} from 'typeorm';

import { type TagKind } from '../types';

import { type EntityTag, EntityTagEntity } from './EntityTagEntity';

@Entity({ schema: 'ci_search', name: 'tags' })
@Unique(['label', 'userId'])
export class TagEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  label!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  // Taxonomy LEVEL (20260916025313_planning_tag_taxonomy). NULL = untyped,
  // the state of every tag that predates this column. Orthogonal to
  // EntityTagEntity.level -- see that class's own note.
  @Column({ type: 'text', nullable: true })
  kind!: TagKind | null;

  @Column({ type: 'boolean', default: false })
  muted!: boolean;

  @Column({ name: 'is_base', type: 'boolean', default: false })
  isBase!: boolean;

  @OneToMany(() => EntityTagEntity, (entityTag) => entityTag.tag)
  entities?: EntityTagEntity[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  static toEgressType(entity: TagEntity): Tag {
    return {
      id: entity.id,
      label: entity.label,
      description: entity.description,
      userId: entity.userId,
      kind: entity.kind,
      muted: entity.muted,
      isBase: entity.isBase,
      entities: entity.entities ? entity.entities.map((et) => EntityTagEntity.toEgressType(et)) : undefined,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      deletedAt: entity.deletedAt,
    };
  }
}

export type Tag = Readonly<
  Omit<TagEntity, 'entities'> & {
    entities?: EntityTag[];
  }
>;

export type TimestampedTag = Readonly<Pick<Tag, 'id' | 'label'> & Pick<EntityTag, 'taggedAt'>>;
