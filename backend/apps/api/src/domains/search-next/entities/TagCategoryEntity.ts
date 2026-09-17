import { Entity, PrimaryColumn } from 'typeorm';

/**
 * Category axis membership: which `kind = 'category'` tags a
 * `kind = 'intention'` tag belongs to (CI-Planning `tag_categories`, 0069) --
 * a verbatim mirror of {@link TagDirectionEntity} on this SECOND, orthogonal
 * grouping. An intention with no row here is "Unsorted" on the category
 * (Balance) view.
 *
 * No `@ManyToOne` relation to `TagEntity` -- see {@link TagDirectionEntity}'s
 * header for why: `TagService` reads/writes this table by raw id only, and
 * an eager single-valued relation here would inherit the fragile
 * TagEntity/EntityTagEntity load-order dependency for no benefit.
 */
@Entity({ schema: 'ci_search', name: 'tag_categories' })
export class TagCategoryEntity {
  @PrimaryColumn({ name: 'intention_tag_id', type: 'uuid' })
  intentionTagId!: string;

  @PrimaryColumn({ name: 'category_tag_id', type: 'uuid' })
  categoryTagId!: string;
}
