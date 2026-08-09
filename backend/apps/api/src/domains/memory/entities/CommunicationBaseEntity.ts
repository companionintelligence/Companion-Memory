import { ChildEntity, Column } from 'typeorm';

import { BaseEntity } from './BaseEntity';

/**
 * The `ci.entities` half of a communication's CTI aggregate: a
 * `Communication`-discriminated base row sharing its uuid with the
 * `ci.communications` detail row (`communications.id = entities.entity_id`,
 * enforced by the `communications_id_entities_fk` foreign key).
 *
 * Unlike Item/Event, communications have no name column to normalize away —
 * subject/content/preview/summary are domain data and stay on the detail. The
 * base row's `name` is a DERIVED display label
 * (`subject ?? preview ?? previewFromContent(content)`) and `description`
 * mirrors `summary`; {@link CommunicationService} re-derives both whenever the
 * source fields change, so graph consumers always see a current label.
 *
 * No decorated `@OneToOne` (the double-mapped-PK footgun); the service
 * composes the aggregate by shared id.
 */
@ChildEntity('Communication')
export class CommunicationBaseEntity extends BaseEntity {
  /** Always `'communications'` — self-describing provenance for linked lookups. */
  @Column({ type: 'text', name: 'linked_table', nullable: true })
  linkedTable!: string | null;

  /** The shared uuid again, so linked-record lookups resolve the detail row. */
  @Column({ type: 'text', name: 'linked_id', nullable: true })
  linkedId!: string | null;
}
