import { defineEvent } from '@ci/domains/events';

/**
 * Event emitted when creating a new content.
 *
 * @see {@link ContentService.create} - The method that emits this event
 */
export const ContentCreatedEvent = 'content.created';
export const ContentUpdatedEvent = 'content.updated';
export const ContentRemovedEvent = 'content.deleted';

/**
 * Event payload of the event {@link ContentCreatedEvent}.
 *
 * @see {@link ContentCreatedEvent} - The event this payload is associated with
 * @see {@link ContentService.create} - The method that emits this event payload
 */
export type ContentCreatedPayload = {
  /** The identifier of the newly created content */
  contentId: string;
};

/**
 * Event payload of the event {@link ContentUpdatedEvent}.
 *
 * @see {@link ContentUpdatedEvent} - The event this payload is associated with
 * @see {@link ContentService.update} - The method that emits this event payload
 */
export type ContentUpdatedPayload = {
  /** The identifier of the newly created content */
  contentId: string;
};

/**
 * Event payload of the event {@link ContentRemovedEvent}.
 *
 * @see {@link ContentRemovedEvent} - The event this payload is associated with
 * @see {@link ContentService.remove} - The method that emits this event payload
 */
export type ContentDeletedPayload = {
  /** The identifier of the newly created content */
  contentId: string;
};

defineEvent<ContentCreatedPayload>(ContentCreatedEvent);
defineEvent<ContentUpdatedPayload>(ContentUpdatedEvent);
defineEvent<ContentDeletedPayload>(ContentRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ContentCreatedEvent]: ContentCreatedPayload;
    [ContentUpdatedEvent]: ContentUpdatedPayload;
    [ContentRemovedEvent]: ContentDeletedPayload;
  }
}

/**
 * Event emitted when creating a new communication.
 *
 * @see {@link CommunicationService.create} - The method that emits this event
 */
export const CommunicationCreatedEvent = 'communication.created';
export const CommunicationUpdatedEvent = 'communication.updated';
export const CommunicationRemovedEvent = 'communication.deleted';

/**
 * Event payload of the event {@link CommunicationCreatedEvent}.
 *
 * @see {@link CommunicationCreatedEvent} - The event this payload is associated with
 * @see {@link CommunicationService.create} - The method that emits this event payload
 */
export type CommunicationCreatedPayload = {
  /** The identifier of the newly created communication */
  communicationId: string;
};

/**
 * Event payload of the event {@link CommunicationUpdatedEvent}.
 *
 * @see {@link CommunicationUpdatedEvent} - The event this payload is associated with
 * @see {@link CommunicationService.update} - The method that emits this event payload
 */
export type CommunicationUpdatedPayload = {
  /** The identifier of the newly created communication */
  communicationId: string;
};

/**
 * Event payload of the event {@link CommunicationRemovedEvent}.
 *
 * @see {@link CommunicationRemovedEvent} - The event this payload is associated with
 * @see {@link CommunicationService.remove} - The method that emits this event payload
 */
export type CommunicationDeletedPayload = {
  /** The identifier of the newly created communication */
  communicationId: string;
};

defineEvent<CommunicationCreatedPayload>(CommunicationCreatedEvent);
defineEvent<CommunicationUpdatedPayload>(CommunicationUpdatedEvent);
defineEvent<CommunicationDeletedPayload>(CommunicationRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [CommunicationCreatedEvent]: CommunicationCreatedPayload;
    [CommunicationUpdatedEvent]: CommunicationUpdatedPayload;
    [CommunicationRemovedEvent]: CommunicationDeletedPayload;
  }
}

/**
 * Event emitted when creating a new event.
 *
 * @see {@link EventService.create} - The method that emits this event
 */
export const EventCreatedEvent = 'event.created';
export const EventUpdatedEvent = 'event.updated';
export const EventRemovedEvent = 'event.deleted';

/**
 * Event payload of the event {@link EventCreatedEvent}.
 *
 * @see {@link EventCreatedEvent} - The event this payload is associated with
 * @see {@link EventService.create} - The method that emits this event payload
 */
export type EventCreatedPayload = {
  /** The identifier of the newly created event */
  eventId: string;
};

/**
 * Event payload of the event {@link EventUpdatedEvent}.
 *
 * @see {@link EventUpdatedEvent} - The event this payload is associated with
 * @see {@link EventService.update} - The method that emits this event payload
 */
export type EventUpdatedPayload = {
  /** The identifier of the newly created event */
  eventId: string;
};

/**
 * Event payload of the event {@link EventRemovedEvent}.
 *
 * @see {@link EventRemovedEvent} - The event this payload is associated with
 * @see {@link EventService.remove} - The method that emits this event payload
 */
export type EventDeletedPayload = {
  /** The identifier of the newly created event */
  eventId: string;
};

defineEvent<EventCreatedPayload>(EventCreatedEvent);
defineEvent<EventUpdatedPayload>(EventUpdatedEvent);
defineEvent<EventDeletedPayload>(EventRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [EventCreatedEvent]: EventCreatedPayload;
    [EventUpdatedEvent]: EventUpdatedPayload;
    [EventRemovedEvent]: EventDeletedPayload;
  }
}

/**
 * Event emitted when creating a new person.
 *
 * @see {@link PersonService.create} - The method that emits this person
 */
export const PersonCreatedEvent = 'person.created';
export const PersonUpdatedEvent = 'person.updated';
export const PersonRemovedEvent = 'person.deleted';

/**
 * Person payload of the event {@link PersonCreatedEvent}.
 *
 * @see {@link PersonCreatedEvent} - The person this payload is associated with
 * @see {@link PersonService.create} - The method that emits this person payload
 */
export type PersonCreatedPayload = {
  /** The identifier of the newly created person */
  personId: string;
};

/**
 * Person payload of the event {@link PersonUpdatedEvent}.
 *
 * @see {@link PersonUpdatedEvent} - The person this payload is associated with
 * @see {@link PersonService.update} - The method that emits this person payload
 */
export type PersonUpdatedPayload = {
  /** The identifier of the newly created person */
  personId: string;
};

/**
 * Person payload of the event {@link PersonRemovedEvent}.
 *
 * @see {@link PersonRemovedEvent} - The person this payload is associated with
 * @see {@link PersonService.remove} - The method that emits this person payload
 */
export type PersonDeletedPayload = {
  /** The identifier of the newly created person */
  personId: string;
};

defineEvent<PersonCreatedPayload>(PersonCreatedEvent);
defineEvent<PersonUpdatedPayload>(PersonUpdatedEvent);
defineEvent<PersonDeletedPayload>(PersonRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [PersonCreatedEvent]: PersonCreatedPayload;
    [PersonUpdatedEvent]: PersonUpdatedPayload;
    [PersonRemovedEvent]: PersonDeletedPayload;
  }
}

/**
 * Event emitted when creating a new item.
 *
 * @see {@link ItemService.create} - The method that emits this item
 */
export const ItemCreatedEvent = 'item.created';
export const ItemUpdatedEvent = 'item.updated';
export const ItemRemovedEvent = 'item.deleted';

/**
 * Item payload of the event {@link ItemCreatedEvent}.
 *
 * @see {@link ItemCreatedEvent} - The item this payload is associated with
 * @see {@link ItemService.create} - The method that emits this item payload
 */
export type ItemCreatedPayload = {
  /** The identifier of the newly created item */
  itemId: string;
};

/**
 * Item payload of the event {@link ItemUpdatedEvent}.
 *
 * @see {@link ItemUpdatedEvent} - The item this payload is associated with
 * @see {@link ItemService.update} - The method that emits this item payload
 */
export type ItemUpdatedPayload = {
  /** The identifier of the newly created item */
  itemId: string;
};

/**
 * Item payload of the event {@link ItemRemovedEvent}.
 *
 * @see {@link ItemRemovedEvent} - The item this payload is associated with
 * @see {@link ItemService.remove} - The method that emits this item payload
 */
export type ItemDeletedPayload = {
  /** The identifier of the newly created item */
  itemId: string;
};

defineEvent<ItemCreatedPayload>(ItemCreatedEvent);
defineEvent<ItemUpdatedPayload>(ItemUpdatedEvent);
defineEvent<ItemDeletedPayload>(ItemRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ItemCreatedEvent]: ItemCreatedPayload;
    [ItemUpdatedEvent]: ItemUpdatedPayload;
    [ItemRemovedEvent]: ItemDeletedPayload;
  }
}

/**
 * Event emitted when creating a new concept.
 */
export const ConceptCreatedEvent = 'concept.created';
export const ConceptUpdatedEvent = 'concept.updated';
export const ConceptRemovedEvent = 'concept.deleted';

/**
 * Concept payload of the event {@link ConceptCreatedEvent}.
 */
export type ConceptCreatedPayload = {
  /** The identifier of the newly created concept */
  conceptId: string;
};

/**
 * Concept payload of the event {@link ConceptUpdatedEvent}.
 */
export type ConceptUpdatedPayload = {
  /** The identifier of the updated concept */
  conceptId: string;
};

/**
 * Concept payload of the event {@link ConceptRemovedEvent}.
 */
export type ConceptDeletedPayload = {
  /** The identifier of the removed concept */
  conceptId: string;
};

defineEvent<ConceptCreatedPayload>(ConceptCreatedEvent);
defineEvent<ConceptUpdatedPayload>(ConceptUpdatedEvent);
defineEvent<ConceptDeletedPayload>(ConceptRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ConceptCreatedEvent]: ConceptCreatedPayload;
    [ConceptUpdatedEvent]: ConceptUpdatedPayload;
    [ConceptRemovedEvent]: ConceptDeletedPayload;
  }
}

/**
 * Event emitted when creating a new place.
 *
 * @see {@link PlaceService.create} - The method that emits this event
 */
export const PlaceCreatedEvent = 'place.created';
export const PlaceUpdatedEvent = 'place.updated';
export const PlaceRemovedEvent = 'place.deleted';

/**
 * Event payload of the event {@link PlaceCreatedEvent}.
 *
 * @see {@link PlaceCreatedEvent} - The event this payload is associated with
 * @see {@link PlaceService.create} - The method that emits this event payload
 */
export type PlaceCreatedPayload = {
  /** The identifier of the newly created place */
  placeId: string;
};

/**
 * Event payload of the event {@link PlaceUpdatedEvent}.
 *
 * @see {@link PlaceUpdatedEvent} - The event this payload is associated with
 * @see {@link PlaceService.update} - The method that emits this event payload
 */
export type PlaceUpdatedPayload = {
  /** The identifier of the newly created place */
  placeId: string;
};

/**
 * Event payload of the event {@link PlaceRemovedEvent}.
 *
 * @see {@link PlaceRemovedEvent} - The event this payload is associated with
 * @see {@link PlaceService.remove} - The method that emits this event payload
 */
export type PlaceDeletedPayload = {
  /** The identifier of the newly created place */
  placeId: string;
};

defineEvent<PlaceCreatedPayload>(PlaceCreatedEvent);
defineEvent<PlaceUpdatedPayload>(PlaceUpdatedEvent);
defineEvent<PlaceDeletedPayload>(PlaceRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [PlaceCreatedEvent]: PlaceCreatedPayload;
    [PlaceUpdatedEvent]: PlaceUpdatedPayload;
    [PlaceRemovedEvent]: PlaceDeletedPayload;
  }
}

/**
 * Event emitted to enqueue a forward-geocode backfill batch (geodata-plan
 * Phase 1). Handled by {@link GeocodeBatchListener}, which selects events
 * carrying a location_name but no location_coordinates and resolves them via
 * GeocodeService.
 *
 * @see {@link GeocodeBatchListener.handleBatch} - The listener that consumes this event
 */
export const GeocodeBatchRequestEvent = 'event.geocode-batch-request';

/**
 * Event payload of {@link GeocodeBatchRequestEvent}.
 */
export type GeocodeBatchRequestPayload = {
  /** Owner whose events are geocoded. */
  userId: string;
  /** Optional explicit set of event ids to geocode; overrides the auto-selection. */
  eventIds?: string[];
  /** Max number of events to process in this batch (default: config.geocoding.batchSize). */
  limit?: number;
  /**
   * When true, re-attempt NULL-coordinate events INCLUDING ones a prior run
   * tagged virtual (metadata.location_source = 'virtual') or negative-cached,
   * and bust the geocode cache so the provider is actually re-queried (e.g.
   * after an API-key change or a denylist/heuristic fix). Default (false) keeps
   * the cheap path: only never-resolved rows, virtual-tagged rows skipped, and
   * negative results served from cache.
   */
  retryNull?: boolean;
  /**
   * Which direction to run. 'forward' (default) geocodes location_name -> coords
   * for events missing coordinates; 'reverse' geocodes coords -> location_name
   * for events that have coordinates (e.g. from photo EXIF / GPS) but no name,
   * so a bare pin gets a readable label. Both directions share this queue + the
   * listener's single rate limiter so they never collectively exceed the
   * provider's QPS.
   */
  direction?: 'forward' | 'reverse';
};

defineEvent<GeocodeBatchRequestPayload>(GeocodeBatchRequestEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [GeocodeBatchRequestEvent]: GeocodeBatchRequestPayload;
  }
}

/**
 * Event emitted to enqueue a temporal location-ESTIMATION backfill batch
 * (geodata-plan Phase 3). Handled by {@link EstimateLocationBatchListener},
 * which fills location_coordinates for physical-presence events that have no
 * coordinates of their own by borrowing the nearest-in-time REAL location (a
 * ci.position GPS fix, else a located event) within a bounded time gap —
 * mirroring LifeScope's "coordinates set to the non-estimated location closest
 * in time". Estimated rows are flagged is_inferred + metadata.location_source
 * = 'estimated' so they're distinguishable from measured/geocoded coordinates.
 *
 * @see {@link EstimateLocationBatchListener.handleBatch} - The listener that consumes this event
 */
export const EstimateLocationBatchRequestEvent = 'event.estimate-location-batch-request';

/**
 * Event payload of {@link EstimateLocationBatchRequestEvent}.
 */
export type EstimateLocationBatchRequestPayload = {
  /** Owner whose events are estimated. */
  userId: string;
  /** Max number of coordinate-less events to fill in this batch. */
  limit?: number;
  /**
   * Maximum time gap (hours) between a candidate event and its donor location.
   * A candidate with no real location within this window is left unestimated, so
   * a location-less event is never pinned to somewhere days away. Default 24.
   */
  maxGapHours?: number;
  /**
   * Restrict candidates to these `source_system`s (physical-presence events that
   * represent BEING somewhere — calendar, photos, purchases, transport, fitness).
   * Messages/social posts are excluded by default so a 3am email isn't snapped to
   * yesterday's restaurant. Defaults to {@link DEFAULT_ESTIMATE_SOURCE_SYSTEMS}.
   */
  sourceSystems?: string[];
  /**
   * Forced re-sweep: also reconsider rows already tagged
   * `metadata.location_source = 'estimated'`. Without this, prior estimates are
   * frozen — even when a new donor source (a wave of GPS positions, a freshly
   * geocoded calendar) would now beat them. Use after backfilling new donors.
   * Defaults to false (standard incremental, NULL-only behaviour).
   */
  forced?: boolean;
};

defineEvent<EstimateLocationBatchRequestPayload>(EstimateLocationBatchRequestEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [EstimateLocationBatchRequestEvent]: EstimateLocationBatchRequestPayload;
  }
}
