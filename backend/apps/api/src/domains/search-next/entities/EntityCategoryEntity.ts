import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A taggable entity's 1-3 categories, position-ordered (CI-Planning
 * `entity_categories`, 0134). Deliberately its own table rather than a third
 * shape inside `entity_tag`: `TagService.getTagsForEntity` selects from
 * `entity_tag` alone, so a category can never appear in that result no
 * matter what this table holds -- see the header of
 * `20260916025313_planning_tag_taxonomy.sql` for the full reasoning.
 *
 * `entity_type` / `entity_id` match `EntityTagEntity`'s columns exactly: same
 * "spans every taggable entity type" identity, same reason there is no FK on
 * them (most of those types are not one single table a foreign key could
 * target). `category_tag_id` DOES FK `ci_search.tags(id) ON DELETE CASCADE`,
 * so deleting a category tag drops every entity's assignment of it with no
 * app-level cleanup required here.
 *
 * `position` (not `level` -- see the migration header) orders an entity's
 * categories; capping it at 3 and keeping it dense on write is
 * `TagService.setEntityCategories`'s job, not a DB constraint, matching how
 * `entity_tag`'s own integrity is app-enforced rather than FK-enforced.
 *
 * No `@ManyToOne` relation to `TagEntity` -- see `TagDirectionEntity`'s
 * header (same reasoning: `TagService` reads/writes this table by raw id
 * through `createQueryBuilder`, never a loaded relation, and a single-valued
 * eager relation here would inherit the fragile TagEntity/EntityTagEntity
 * load-order dependency for no benefit).
 */
@Entity({ schema: 'ci_search', name: 'entity_categories' })
export class EntityCategoryEntity {
  @PrimaryColumn({ name: 'entity_type', type: 'text' })
  entityType!: string;

  @PrimaryColumn({ name: 'entity_id', type: 'uuid' })
  entityId!: string;

  @Index('entity_categories_category_tag_id_idx')
  @PrimaryColumn({ name: 'category_tag_id', type: 'uuid' })
  categoryTagId!: string;

  @Column({ type: 'smallint', default: 0 })
  position!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  static toEgressType(entity: EntityCategoryEntity): EntityCategory {
    return {
      entityType: entity.entityType,
      entityId: entity.entityId,
      categoryTagId: entity.categoryTagId,
      position: entity.position,
      createdAt: entity.createdAt,
    };
  }
}

export type EntityCategory = Readonly<Omit<EntityCategoryEntity, 'toEgressType'>>;
