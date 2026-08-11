import { ChildEntity, Column } from 'typeorm';

import { BaseEntity } from './BaseEntity';

/**
 * The `ci.entities` half of a content CTI aggregate: a `Content`-discriminated
 * base row sharing its uuid with the `ci.content` detail row
 * (`content.id = entities.entity_id`). The base row is the SOLE owner of the
 * content's title (stored as `name`). Body/url/mimetype stay on the detail.
 *
 * See CI-Server#1941 and {@link ContentService}.
 */
@ChildEntity('Content')
export class ContentBaseEntity extends BaseEntity {
  /** Always `'content'` — self-describing provenance for linked lookups. */
  @Column({ type: 'text', name: 'linked_table', nullable: true })
  linkedTable!: string | null;

  /** The shared uuid again, so linked-record lookups resolve the detail row. */
  @Column({ type: 'text', name: 'linked_id', nullable: true })
  linkedId!: string | null;
}
