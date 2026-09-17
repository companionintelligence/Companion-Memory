import { Entity, PrimaryColumn } from 'typeorm';

/**
 * Direction axis membership: which `kind = 'direction'` tags a
 * `kind = 'intention'` tag belongs to (CI-Planning `tag_directions`,
 * 0036/0043). An intention with no row here is "Unsorted" -- there is no
 * NULL/default-direction row to seed for it.
 *
 * Composite PK, both sides FK `ci_search.tags(id) ON DELETE CASCADE`:
 * deleting either tag drops the membership row automatically. This is
 * unlike `entity_tag`, whose FK to `tags` carries no ON DELETE rule and
 * needs `TagService.purge`'s manual cleanup -- nothing here needs that.
 *
 * No `@ManyToOne` relation to `TagEntity` here on purpose. `TagService`
 * only ever reads/writes this table by raw id through `createQueryBuilder`
 * (never `relations: [...]`), and `TagEntity` <-> `EntityTagEntity` already
 * have a real mutual relation that makes their load order order-sensitive
 * under `emitDecoratorMetadata` (a single-valued `@ManyToOne` property
 * needs its target class as a value at decoration time, so whichever of the
 * two is reached first must finish before the other's decorator runs).
 * Adding a THIRD class with an eager `() => TagEntity` relation here would
 * make that fragility depend on this file's import position too -- which
 * `eslint`'s import sort then silently reorders. Plain uuid columns avoid
 * the whole problem; nothing this milestone needs requires the relation.
 */
@Entity({ schema: 'ci_search', name: 'tag_directions' })
export class TagDirectionEntity {
  @PrimaryColumn({ name: 'intention_tag_id', type: 'uuid' })
  intentionTagId!: string;

  @PrimaryColumn({ name: 'direction_tag_id', type: 'uuid' })
  directionTagId!: string;
}
