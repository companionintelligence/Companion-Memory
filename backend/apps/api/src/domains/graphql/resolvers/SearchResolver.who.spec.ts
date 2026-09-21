import type { RequestContext } from '@ci/common/context';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { GlobalUID } from '../types/GlobalUID';
import type { SearchInput } from '../types/SearchInput';

import { SearchResolver } from './SearchResolver';

/**
 * The Who filter (`people`) reaches every kind that links to people — events
 * through their participants, communications through sender / recipients —
 * and sets every other kind aside. The Where family stays event-only. Covered
 * on both execution paths: the timed browse (predicates pushed into each
 * service's SQL) and the query path (candidates post-filtered against what
 * each service reports as matching).
 */
const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT = { userId: USER } as RequestContext;

const EVENT = { id: '018e0000-0000-7000-8000-0000000000e1', startTime: new Date('2026-03-04T12:00:00.000Z') };
const OTHER_EVENT = {
  id: '018e0000-0000-7000-8000-0000000000e2',
  startTime: new Date('2026-03-03T12:00:00.000Z'),
};
const MESSAGE = { id: '018e0000-0000-7000-8000-0000000000c1', time: new Date('2026-03-02T12:00:00.000Z') };
const CONTENT = {
  id: '018e0000-0000-7000-8000-0000000000a1',
  updatedAt: new Date('2026-03-01T12:00:00.000Z'),
};

type Options = Record<string, unknown>;

function makeResolver() {
  const calls = {
    events: [] as Options[],
    communications: [] as Options[],
    communicationCounts: [] as Options[],
    contents: [] as Options[],
  };

  const eventService = {
    getEntitiesForEvents: jest.fn(async (_context: unknown, options: Options) => {
      calls.events.push(options);

      return [{ id: EVENT.id, type: 'event' as IndexableEntity }];
    }),
    countEntitiesForEvents: jest.fn(async () => 1),
  };

  const communicationService = {
    getEntitiesForCommunications: jest.fn(async (_context: unknown, options: Options) => {
      calls.communications.push(options);

      return [{ id: MESSAGE.id, type: 'communication' as IndexableEntity }];
    }),
    countEntitiesForCommunications: jest.fn(async (_context: unknown, options: Options) => {
      calls.communicationCounts.push(options);

      return 1;
    }),
  };

  const contentService = {
    // The query path now also reaches events through matching media; nothing here has any.
    findEventIdsForMedia: jest.fn(async () => []),
    getEntitiesForContents: jest.fn(async (_context: unknown, options: Options) => {
      calls.contents.push(options);

      return [{ id: CONTENT.id, type: 'content' as IndexableEntity }];
    }),
    countEntitiesForContents: jest.fn(async () => 1),
  };

  const entityResolutionService = {
    resolve: jest.fn(async (_context: unknown, identifiers: EntityIdentifier<IndexableEntity>[]) => {
      const map = new Map<string, unknown>();

      for (const { type, id } of identifiers) {
        const entity =
          type === 'event'
            ? { id, startTime: (id === EVENT.id ? EVENT : OTHER_EVENT).startTime, tags: [] }
            : type === 'communication'
              ? { id, time: MESSAGE.time, tags: [] }
              : { id, updatedAt: CONTENT.updatedAt, type: 'media', tags: [] };

        map.set(`${type}:${id}`, { type, id, entity });
      }

      return map;
    }),
  };

  // The query path's ranked candidates: two events (only the first "involves"
  // the person, per eventService above), a message, and a content row.
  const searchService = {
    search: jest.fn(async () => [
      { id: EVENT.id, type: 'event' as IndexableEntity },
      { id: MESSAGE.id, type: 'communication' as IndexableEntity },
      { id: CONTENT.id, type: 'content' as IndexableEntity },
      { id: OTHER_EVENT.id, type: 'event' as IndexableEntity },
    ]),
  };

  const empty = async () => [];
  const stub = (method: string) => ({
    [method]: jest.fn(empty),
    [method.replace('getEntitiesFor', 'countEntitiesFor')]: jest.fn(async () => 0),
  });

  const resolver = new SearchResolver(
    stub('getEntitiesForBrowserActivities') as never,
    communicationService as never,
    stub('getEntitiesForConcepts') as never,
    contentService as never,
    entityResolutionService as never,
    eventService as never,
    stub('getEntitiesForFiles') as never,
    stub('getEntitiesForFileChunks') as never,
    stub('getEntitiesForItems') as never,
    stub('getEntitiesForNotes') as never,
    stub('getEntitiesForPeople') as never,
    stub('getEntitiesForPlaces') as never,
    stub('getEntitiesForProducts') as never,
    stub('getEntitiesForReceipts') as never,
    stub('getEntitiesForAnswers') as never,
    {} as never,
    {
      authorize: jest.fn().mockResolvedValue({ grantId: 'grant-test', ceiling: undefined }),
      recordRead: jest.fn().mockResolvedValue(undefined),
    } as never,
    searchService as never,
    { getEntitiesForTags: jest.fn(empty), searchByLabel: jest.fn(empty) } as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
  );

  return { resolver, calls };
}

function globalIds(page: { edges: Array<{ cursor: string }> }): string[] {
  return page.edges.map((edge) => {
    const decoded = Buffer.from(edge.cursor, 'base64').toString('utf8');

    return decoded.slice(decoded.indexOf('::') + 2);
  });
}

describe('SearchResolver — the Who filter reaches communications', () => {
  describe('timed browse (no query, no tags)', () => {
    it('pushes the person patterns into the event and communication queries and leaves the other kinds unfetched', async () => {
      const { resolver, calls } = makeResolver();

      const page = await resolver.search(CONTEXT, { first: 10, people: ['Ada'] } as SearchInput);

      expect(calls.events[0]).toMatchObject({ people: ['Ada'] });
      expect(calls.communications[0]).toMatchObject({ people: ['Ada'] });
      expect(calls.contents).toHaveLength(0);

      expect(globalIds(page)).toEqual([
        GlobalUID.encode('event', EVENT.id),
        GlobalUID.encode('communication', MESSAGE.id),
      ]);
      // The real total counts the same two kinds under the same predicate.
      expect(calls.communicationCounts[0]).toMatchObject({ people: ['Ada'] });
      expect(page.totalCount).toBe(2);
    });

    it('keeps the Where family event-only, so a place pins the browse to events', async () => {
      const { resolver, calls } = makeResolver();

      const page = await resolver.search(CONTEXT, {
        first: 10,
        people: ['Ada'],
        places: ['Paris'],
      } as SearchInput);

      expect(calls.events[0]).toMatchObject({ people: ['Ada'], places: ['Paris'] });
      expect(calls.communications).toHaveLength(0);
      expect(calls.contents).toHaveLength(0);
      expect(globalIds(page)).toEqual([GlobalUID.encode('event', EVENT.id)]);
    });

    it('does not touch communications at all without a Who filter', async () => {
      const { resolver, calls } = makeResolver();

      await resolver.search(CONTEXT, { first: 10, includeTypes: ['communication'] } as SearchInput);

      expect(calls.communications[0]).not.toHaveProperty('people');
      expect(calls.communicationCounts[0]).not.toHaveProperty('people');
    });
  });

  describe('direction toggle (sent / received)', () => {
    it('pins the timed browse to communications and pushes the direction into their query and count', async () => {
      const { resolver, calls } = makeResolver();

      const page = await resolver.search(CONTEXT, {
        first: 10,
        people: ['Ada'],
        direction: 'inbound',
      } as SearchInput);

      expect(calls.events).toHaveLength(0);
      expect(calls.contents).toHaveLength(0);
      expect(calls.communications[0]).toMatchObject({ people: ['Ada'], direction: 'inbound' });
      expect(calls.communicationCounts[0]).toMatchObject({ people: ['Ada'], direction: 'inbound' });
      expect(globalIds(page)).toEqual([GlobalUID.encode('communication', MESSAGE.id)]);
      expect(page.totalCount).toBe(1);
    });

    it('works without a person too, and ignores a direction the toggle cannot name', async () => {
      const { resolver, calls } = makeResolver();

      await resolver.search(CONTEXT, { first: 10, direction: 'outbound' } as SearchInput);
      expect(calls.events).toHaveLength(0);
      expect(calls.communications[0]).toMatchObject({ direction: 'outbound' });

      await resolver.search(CONTEXT, { first: 10, direction: 'sideways' } as SearchInput);
      expect(calls.events).toHaveLength(1);
      expect(calls.communications[1]).not.toHaveProperty('direction');
    });

    it('post-filters the query path to matching messages only', async () => {
      const { resolver, calls } = makeResolver();

      const page = await resolver.search(CONTEXT, {
        first: 10,
        query: 'hello',
        people: ['Ada'],
        direction: 'outbound',
      } as SearchInput);

      expect(calls.events).toHaveLength(0);
      expect(calls.communications[0]).toMatchObject({ people: ['Ada'], direction: 'outbound', limit: 5000 });
      expect(globalIds(page)).toEqual([GlobalUID.encode('communication', MESSAGE.id)]);
    });
  });

  describe('query path (ranked candidates, post-filtered)', () => {
    it('keeps the events and messages each service reports as involving the person, and drops the rest', async () => {
      const { resolver, calls } = makeResolver();

      const page = await resolver.search(CONTEXT, {
        first: 10,
        query: 'hello',
        people: ['Ada'],
      } as SearchInput);

      expect(calls.events[0]).toMatchObject({ people: ['Ada'], limit: 5000 });
      expect(calls.communications[0]).toMatchObject({ people: ['Ada'], limit: 5000 });
      // OTHER_EVENT was a candidate but eventService did not report it; CONTENT cannot link to a person.
      expect(globalIds(page)).toEqual([
        GlobalUID.encode('event', EVENT.id),
        GlobalUID.encode('communication', MESSAGE.id),
      ]);
    });

    it('skips the communication lookup once a place is set, since only events carry one', async () => {
      const { resolver, calls } = makeResolver();

      const page = await resolver.search(CONTEXT, {
        first: 10,
        query: 'hello',
        people: ['Ada'],
        places: ['Paris'],
      } as SearchInput);

      expect(calls.communications).toHaveLength(0);
      expect(globalIds(page)).toEqual([GlobalUID.encode('event', EVENT.id)]);
    });
  });
});
