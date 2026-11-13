import { BadRequestException } from '@nestjs/common';

import { type RequestContext } from '@ci/common/context';
import { type Event } from '@ci/domains/memory';

import { EventType } from '../../types/EventType';
import { GlobalUID } from '../../types/GlobalUID';
import { EventResolver } from '../EventResolver';

const viewerCtx = { userId: 'viewer-1' } as unknown as RequestContext;

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    userId: 'viewer-1',
    category: null,
    title: 'Some event',
    description: null,
    eventType: null,
    startTime: new Date('2026-08-01T00:00:00Z'),
    endTime: null,
    durationMinutes: null,
    locationName: null,
    locationCoordinates: null,
    locationEntityId: null,
    participantEntityIds: null,
    organizerEntityId: null,
    sourceType: null,
    sourceSystem: null,
    externalSyncStatus: null,
    sourceId: null,
    confidenceScore: null,
    isRecurring: false,
    isAllDay: false,
    metadata: null,
    status: null,
    ...overrides,
  } as unknown as Event;
}

function makeResolver() {
  const eventService = {
    findAll: jest.fn().mockResolvedValue([] as Event[]),
    findPage: jest.fn().mockResolvedValue({
      entities: [] as Event[],
      hasNextPage: false,
      hasPreviousPage: false,
      totalCount: 0,
    }),
    findInRange: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    reschedule: jest.fn(),
    getDistinctEventTypes: jest.fn(),
    getDistinctEventSources: jest.fn(),
  };
  const personLoader = { load: jest.fn(), loadMany: jest.fn().mockResolvedValue([]) };
  const placeLoader = { load: jest.fn() };
  const tagLoader = { load: jest.fn().mockResolvedValue([]) };
  const eventMediaLoader = { load: jest.fn() };
  const eventContentsLoader = { load: jest.fn().mockResolvedValue([]) };

  const resolver = new EventResolver(
    eventService as never,
    personLoader as never,
    placeLoader as never,
    tagLoader as never,
    eventMediaLoader as never,
    eventContentsLoader as never,
  );

  return {
    resolver,
    eventService,
    personLoader,
    placeLoader,
    tagLoader,
    eventMediaLoader,
    eventContentsLoader,
  };
}

describe('EventResolver.events', () => {
  /** What `CalendarEventService.findPage` hands back for one page. */
  function page(entities: Event[], overrides: Record<string, unknown> = {}) {
    return {
      entities,
      hasNextPage: false,
      hasPreviousPage: false,
      totalCount: entities.length,
      ...overrides,
    };
  }

  it('scopes the page read to the requesting viewer', async () => {
    const { resolver, eventService } = makeResolver();

    await resolver.events(viewerCtx, {});

    expect(eventService.findPage).toHaveBeenCalledWith(
      { userId: 'viewer-1' },
      expect.anything(),
      expect.anything(),
    );
  });

  // Pagination lives in the service now (keyset over (start_time, event_id)),
  // not in an in-memory Paginator here: `events` used to findAll the user's
  // whole event table — photos and every ETL row included — and throw all but
  // `first` away. What the resolver still owns is the cursor translation, so
  // that is what these pin.
  it('passes first/last through and decodes after/before cursors to raw row ids', async () => {
    const { resolver, eventService } = makeResolver();

    await resolver.events(viewerCtx, {
      first: 2,
      after: GlobalUID.encode('event', 'e1'),
    });

    expect(eventService.findPage).toHaveBeenCalledWith(
      { userId: 'viewer-1' },
      { first: 2, last: undefined, afterId: 'e1', beforeId: null },
      // No resolve info in a direct call: the resolver asks for the count.
      { countTotal: true },
    );
  });

  it('GlobalUID-encodes cursors and reports the full-set totalCount, not the page length', async () => {
    const { resolver, eventService } = makeResolver();
    eventService.findPage.mockResolvedValue(
      page([makeEvent({ id: 'e1' }), makeEvent({ id: 'e2' })], { totalCount: 3, hasNextPage: true }),
    );

    const result = await resolver.events(viewerCtx, { first: 2 });

    // totalCount must reflect the FULL matching set, not just the returned
    // page — the same contract that made SearchResolver's totalCount
    // fabrication (fixed in 9d13b92c5) a bug.
    expect(result.totalCount).toBe(3);
    expect(result.edges.map((edge) => edge.cursor)).toEqual([
      GlobalUID.encode('event', 'e1'),
      GlobalUID.encode('event', 'e2'),
    ]);
    expect(result.pageInfo).toEqual({
      hasNextPage: true,
      hasPreviousPage: false,
      startCursor: GlobalUID.encode('event', 'e1'),
      endCursor: GlobalUID.encode('event', 'e2'),
    });
  });

  it('returns an empty connection (not an error) when the user has no events', async () => {
    const { resolver, eventService } = makeResolver();
    eventService.findPage.mockResolvedValue(page([]));

    const result = await resolver.events(viewerCtx, {});

    expect(result).toEqual({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    });
  });
});

describe('EventResolver sub-resolvers: entityOwnerScope wiring', () => {
  // These ResolveFields intentionally resolve under the EVENT's owner, not
  // the viewer — the shared-search cross-user read entityOwnerScope exists
  // for. A regression that scoped these to the viewer instead would make a
  // shared search's organizer/location/tags silently come back empty; a
  // regression that scoped them to something OTHER than the true owner would
  // be a tenancy leak. Assert against a viewer that deliberately differs from
  // the event's owner so either mistake fails the test.

  it('organizer resolves against the event owner scope, not the viewer', async () => {
    const { resolver, personLoader } = makeResolver();
    const event = makeEvent({ id: 'e1', userId: 'owner-2', organizerEntityId: 'person-1' });
    const parent = EventType.toType(event);
    personLoader.load.mockResolvedValue({ id: 'person-1', name: 'Alice' });

    await resolver.organizer(viewerCtx, parent);

    expect(personLoader.load).toHaveBeenCalledWith({ userId: 'owner-2' }, 'person-1');
  });

  it('organizer falls back to the viewer scope when the event carries no owner', async () => {
    const { resolver, personLoader } = makeResolver();
    const event = makeEvent({ id: 'e1', userId: null as unknown as string, organizerEntityId: 'person-1' });
    const parent = EventType.toType(event);
    personLoader.load.mockResolvedValue({ id: 'person-1', name: 'Alice' });

    await resolver.organizer(viewerCtx, parent);

    expect(personLoader.load).toHaveBeenCalledWith({ userId: 'viewer-1' }, 'person-1');
  });

  it('location resolves against the event owner scope, not the viewer', async () => {
    const { resolver, placeLoader } = makeResolver();
    const event = makeEvent({ id: 'e1', userId: 'owner-2', locationEntityId: 'place-1' });
    const parent = EventType.toType(event);
    placeLoader.load.mockResolvedValue({ id: 'place-1', name: 'Home' });

    await resolver.location(viewerCtx, parent);

    expect(placeLoader.load).toHaveBeenCalledWith({ userId: 'owner-2' }, 'place-1');
  });

  it('tags resolves against the event owner scope, not the viewer', async () => {
    const { resolver, tagLoader } = makeResolver();
    const event = makeEvent({ id: 'e1', userId: 'owner-2' });
    const parent = EventType.toType(event);

    await resolver.tags(viewerCtx, parent);

    expect(tagLoader.load).toHaveBeenCalledWith({ userId: 'owner-2' }, { type: 'event', id: 'e1' });
  });

  it('media fields resolve against the event owner scope, not the viewer', async () => {
    const { resolver, eventMediaLoader } = makeResolver();
    const event = makeEvent({ id: 'e1', userId: 'owner-2' });
    const parent = EventType.toType(event);
    eventMediaLoader.load.mockResolvedValue(null);

    await resolver.previewUrl(viewerCtx, parent);

    expect(eventMediaLoader.load).toHaveBeenCalledWith({ userId: 'owner-2' }, 'e1');
  });
});

describe('EventResolver time ordering', () => {
  const START = new Date('2026-09-10T10:00:00Z');
  const BEFORE_START = new Date('2026-09-10T08:00:00Z');
  const AFTER_START = new Date('2026-09-10T11:00:00Z');

  // ci.events' `valid_time_range` CHECK is otherwise the first thing to see
  // these, and formatError reduces the 23514 to a bare `Internal server
  // error`. rescheduleEvent has always answered 400; every mutation that
  // names both ends must agree with it.
  it('createEvent refuses an endTime before its startTime', async () => {
    const { resolver, eventService } = makeResolver();

    await expect(
      resolver.createEvent(viewerCtx, { title: 'Standup', startTime: START, endTime: BEFORE_START }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(eventService.create).not.toHaveBeenCalled();
  });

  it('createEvents refuses the whole batch when one row is reversed', async () => {
    const { resolver, eventService } = makeResolver();

    await expect(
      resolver.createEvents(viewerCtx, [
        { title: 'Standup', startTime: START, endTime: AFTER_START },
        { title: 'Retro', startTime: START, endTime: BEFORE_START },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(eventService.create).not.toHaveBeenCalled();
  });

  it('updateEvent refuses a reversed pair', async () => {
    const { resolver, eventService } = makeResolver();

    await expect(
      resolver.updateEvent(viewerCtx, {
        id: GlobalUID.encode('event', '11111111-1111-1111-1111-111111111111'),
        // UpdateEventInput declares `title` nullable but types it non-optional,
        // so TS wants it even though the mutation does not.
        title: 'Standup',
        startTime: START,
        endTime: BEFORE_START,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(eventService.update).not.toHaveBeenCalled();
  });

  // Equal instants are legal: the CHECK is `start_time <= end_time`, and a
  // zero-length marker is a real thing to store.
  it('accepts an endTime equal to startTime', async () => {
    const { resolver, eventService } = makeResolver();
    eventService.create.mockResolvedValue([makeEvent()]);

    await resolver.createEvent(viewerCtx, { title: 'Marker', startTime: START, endTime: START });

    expect(eventService.create).toHaveBeenCalled();
  });
});

describe('EventResolver links and coordinates', () => {
  const START = new Date('2026-09-10T10:00:00Z');
  const PERSON = '01a1d486-4136-77cf-8428-f1b56f741102';
  const PLACE = '01a1d486-2dfd-739f-ad39-c0ddfda293c9';

  // createPerson and createPlace answer with global ids, and the link fields are
  // typed `ID`. Passed through as is, a global id failed the uuid cast in
  // refuseForeignLinks and formatError reported "Internal server error".
  it('takes the global ids createPerson and createPlace return, and stores their uuids', async () => {
    const { resolver, eventService } = makeResolver();
    eventService.create.mockResolvedValue([makeEvent()]);

    await resolver.createEvent(viewerCtx, {
      title: 'Lunch',
      startTime: START,
      participantEntityIds: [GlobalUID.encode('person', PERSON), PERSON],
      organizerEntityId: GlobalUID.encode('person', PERSON),
      locationEntityId: GlobalUID.encode('place', PLACE),
    });

    expect(eventService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        participant_entity_ids: [PERSON, PERSON],
        organizer_entity_id: PERSON,
        location_entity_id: PLACE,
      }),
    );
  });

  it.each([
    ['an id that is neither a uuid nor a global id', 'not-an-id'],
    ["a place's global id", GlobalUID.encode('place', PLACE)],
    ['a global id with no uuid in it', GlobalUID.encode('person', 'dana')],
  ])('answers 400 naming the field for %s', async (_label, id) => {
    const { resolver, eventService } = makeResolver();

    await expect(
      resolver.createEvent(viewerCtx, { title: 'Lunch', startTime: START, participantEntityIds: [id] }),
    ).rejects.toThrow(
      new BadRequestException(`\`participantEntityIds\` takes a person id or its uuid; got "${id}"`),
    );
    expect(eventService.create).not.toHaveBeenCalled();
  });

  it('passes a bare uuid through in any spelling Postgres reads, as before', async () => {
    const { resolver, eventService } = makeResolver();
    eventService.create.mockResolvedValue([makeEvent()]);
    const spellings = [PERSON.toUpperCase(), PERSON.replaceAll('-', ''), `{${PERSON}}`];

    await resolver.createEvent(viewerCtx, {
      title: 'Lunch',
      startTime: START,
      participantEntityIds: spellings,
      organizerEntityId: '',
    });

    expect(eventService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ participant_entity_ids: spellings, organizer_entity_id: '' }),
    );
  });

  it('applies the same to updateEvent', async () => {
    const { resolver, eventService } = makeResolver();
    eventService.update.mockResolvedValue(makeEvent());

    await resolver.updateEvent(viewerCtx, {
      id: GlobalUID.encode('event', '11111111-1111-1111-1111-111111111111'),
      title: 'Lunch',
      participantEntityIds: [GlobalUID.encode('person', PERSON)],
    });

    expect(eventService.update).toHaveBeenCalledWith(
      expect.anything(),
      '11111111-1111-1111-1111-111111111111',
      expect.objectContaining({ participant_entity_ids: [PERSON] }),
    );
  });

  it.each([
    ['{ lat, lng }', { lat: 47.6, lng: -122.3 }],
    ['a latitude past 90', { type: 'Point', coordinates: [-122.3, 200] }],
    ['a longitude past 180', { type: 'Point', coordinates: [200, 47.6] }],
    ['a third coordinate', { type: 'Point', coordinates: [-122.3, 47.6, 10] }],
    ['coordinates that are not numbers', { type: 'Point', coordinates: ['-122.3', '47.6'] }],
    ['another GeoJSON type', { type: 'LineString', coordinates: [[-122.3, 47.6]] }],
  ])('answers 400 for locationCoordinates as %s', async (_label, locationCoordinates) => {
    const { resolver, eventService } = makeResolver();

    await expect(
      resolver.createEvent(viewerCtx, {
        title: 'Lunch',
        startTime: START,
        locationCoordinates: locationCoordinates as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      resolver.createEvents(viewerCtx, [
        { title: 'Lunch', startTime: START, locationCoordinates: locationCoordinates as never },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(eventService.create).not.toHaveBeenCalled();
  });

  it('stores a GeoJSON Point as before', async () => {
    const { resolver, eventService } = makeResolver();
    eventService.create.mockResolvedValue([makeEvent()]);

    await resolver.createEvent(viewerCtx, {
      title: 'Lunch',
      startTime: START,
      locationCoordinates: { type: 'Point', coordinates: [-122.3, 47.6] },
    });

    expect(eventService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ location_coordinates: { type: 'Point', coordinates: [-122.3, 47.6] } }),
    );
  });
});
