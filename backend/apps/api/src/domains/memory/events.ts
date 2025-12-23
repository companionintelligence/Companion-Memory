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
