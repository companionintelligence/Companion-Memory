import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import { IndexableEntity } from '@ci/domains/search-next';

import type { SavedSearchFilters } from '../types';

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

  @Column({ array: true, type: 'text', name: 'tags', nullable: true })
  tags!: string[];

  // Secondary explorer dimensions (who / where / when / how / sort / semantic)
  // so a saved search round-trips the full search, not just query/types/tags.
  @Column({ type: 'jsonb', name: 'filters', nullable: true })
  filters!: SavedSearchFilters | null;

  @Column({ type: 'uuid', name: 'user_id' })
  userId?: string;

  // Sharing (LifeScope tag-stream parity). When `isPublic` is true, `shareToken`
  // holds an unguessable capability that lets another signed-in user open this
  // search and run it as the owner. Toggling sharing off clears the token.
  @Column({ type: 'boolean', name: 'is_public', default: false })
  isPublic!: boolean;

  @Column({ type: 'text', name: 'share_token', nullable: true })
  shareToken!: string | null;

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
      filters: entity.filters,
      userId: entity.userId,
      isPublic: entity.isPublic,
      shareToken: entity.shareToken,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type SavedSearch = Readonly<SavedSearchEntity>;
