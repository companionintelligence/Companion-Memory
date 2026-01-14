import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import { IndexableEntity } from '@ci/domains/search-next';

@Entity({ schema: 'ci', name: 'saved_searches' })
export class SavedSearchEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  @Column({ type: 'text', name: 'name', nullable: true })
  name!: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description!: string;

  @Column({ type: 'text', name: 'query', nullable: true })
  query!: string;

  @Column({ array: true, type: 'text', name: 'entity_types' })
  entityTypes!: IndexableEntity[];

  @Column({ array: true, type: 'uuid', name: 'tags', nullable: true })
  tags!: string[];

  @Column({ type: 'uuid', name: 'user_id' })
  userId?: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: SavedSearchEntity): SavedSearch {
    return {
      id: entity.id,
      name: entity.name,
      description: entity.description,
      query: entity.query,
      entityTypes: entity.entityTypes,
      tags: entity.tags,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type SavedSearch = Readonly<SavedSearchEntity>;
