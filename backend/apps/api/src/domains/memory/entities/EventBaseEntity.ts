import { ChildEntity, Column } from 'typeorm';

import { BaseEntity } from './BaseEntity';

/**
 * The `ci.entities` half of an event's CTI aggregate: an `Event`-discriminated
 * base row sharing its uuid with the `ci.events` detail row
 * (`events.event_id = entities.entity_id`, enforced by the
 * `events_event_id_entities_fk` foreign key). The base row is the SOLE owner of
 * the event's title (stored as `name`) and `description` — the detail table
 * carries only event-specific data — so every egress read composes the pair
 * (see {@link CalendarEventService}).
 *
 * This class has no egress type of its own; {@link CalendarEventService} is its only
 * surface. No decorated `@OneToOne` to `EventEntity` (the double-mapped-PK
 * footgun); the service composes the aggregate by shared id.
 */
@ChildEntity('Event')
export class EventBaseEntity extends BaseEntity {
  /** Always `'events'` — self-describing provenance for the linked lookups. */
  @Column({ type: 'text', name: 'linked_table', nullable: true })
  linkedTable!: string | null;

  /** The shared uuid again, so linked-record lookups resolve the detail row. */
  @Column({ type: 'text', name: 'linked_id', nullable: true })
  linkedId!: string | null;

  /**
   * `ci.entities.is_active` — the graph half of the event's tombstone.
   *
   * Every graph reader (GraphUtilityService's node reads, node counts, the
   * deterministic edge matrix's endpoint join) sees only this row and decides
   * liveness from this flag; every event reader decides it from
   * `ci.events.is_deleted`. {@link CalendarEventService.remove} and
   * {@link CalendarEventService.restore} therefore flip both together, so the
   * two families never disagree about whether an event exists.
   */
  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;
}
