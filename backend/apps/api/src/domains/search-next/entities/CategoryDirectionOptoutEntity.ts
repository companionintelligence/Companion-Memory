import { Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-category direction SCOPE, OPT-OUT polarity (CI-Planning
 * `category_direction_optouts`, 0069). A row means "this category tag does
 * NOT apply under this direction tag"; the absence of one means it does.
 * Every category is on for every direction -- including a direction added
 * after the category was created -- with zero backfill, which is the whole
 * reason for choosing this polarity over an opt-in table.
 *
 * No `@ManyToOne` relation to `TagEntity` -- see {@link TagDirectionEntity}'s
 * header (same reasoning, same reason to avoid it here).
 */
@Entity({ schema: 'ci_search', name: 'category_direction_optouts' })
export class CategoryDirectionOptoutEntity {
  @PrimaryColumn({ name: 'category_tag_id', type: 'uuid' })
  categoryTagId!: string;

  @PrimaryColumn({ name: 'direction_tag_id', type: 'uuid' })
  directionTagId!: string;
}
