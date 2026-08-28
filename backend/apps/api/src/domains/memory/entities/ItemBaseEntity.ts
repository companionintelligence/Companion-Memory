import { ChildEntity, Column } from 'typeorm';

import { BaseEntity } from './BaseEntity';

/**
 * The `ci.entities` half of an thing's CTI aggregate: an
 * `Item`-discriminated base row sharing its uuid with the `ci.objects` detail
 * row (`objects.object_id = entities.entity_id`, enforced by the
 * `objects_object_id_entities_fk` foreign key). The base row is the SOLE
 * owner of `name`/`description` — the detail table carries only item-specific
 * data — so every egress read composes the pair (see
 * {@link ItemService.composeMany}).
 *
 * This class has no egress type of its own; {@link ItemService} is its only
 * surface. There is deliberately no decorated `@OneToOne` to `ItemEntity`:
 * declaring a `@JoinColumn` on a column that is already the `@PrimaryColumn`
 * double-maps it, and the service composes the aggregate by shared id instead.
 */
@ChildEntity('Item')
export class ItemBaseEntity extends BaseEntity {
  /** Always `'objects'` — self-describing provenance for the linked lookups. */
  @Column({ type: 'text', name: 'linked_table', nullable: true })
  linkedTable!: string | null;

  /** The shared uuid again, so linked-record lookups resolve the detail row. */
  @Column({ type: 'text', name: 'linked_id', nullable: true })
  linkedId!: string | null;
}
