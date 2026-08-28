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

  /**
   * The most a reader of this share may ever receive, as a
   * `DISCLOSURE_RUNGS` rung. Stamped onto each reader's `ci.ask_grants` row
   * when they first open the link, then combined with whatever this column says
   * later by taking the NARROWER of the two — so tightening a live share
   * tightens existing readers, and loosening it does not retroactively widen
   * what they already consented under.
   *
   * Typed `string | null` rather than `DisclosureRung | null` on purpose: this
   * is the RAW column, and `ceilingForShare` in the asks domain is the total
   * function that resolves it (absent -> no ceiling, unreadable -> the
   * strictest one). Typing it as the union here would assert a guarantee the
   * column cannot make and would hide the unreadable case from the one place
   * that handles it.
   */
  @Column({ type: 'text', name: 'share_max_disclosure', nullable: true })
  shareMaxDisclosure!: string | null;

  /** Scheduled lapse for the link. NULL = stands until the owner unshares. */
  @Column({ type: 'timestamptz', name: 'share_expires_at', nullable: true })
  shareExpiresAt!: Date | null;

  // Marks a row `ensureDefaults` bulk-inserted from the starter library, as
  // opposed to one the user created themselves. Never set outside seeding.
  @Column({ type: 'boolean', name: 'is_seed', default: false })
  isSeed!: boolean;

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
      shareMaxDisclosure: entity.shareMaxDisclosure,
      shareExpiresAt: entity.shareExpiresAt,
      isSeed: entity.isSeed,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type SavedSearch = Readonly<SavedSearchEntity>;
