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

import { type EntityTag, EntityTagEntity } from './EntityTagEntity';

@Entity({ name: 'tags', schema: 'ci_search' })
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

export type TimestampedTag = Readonly<Pick<Tag, 'label'> & Pick<EntityTag, 'taggedAt'>>;
