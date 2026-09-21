import type { RequestContext } from '@ci/common/context';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { GlobalUID } from '../types/GlobalUID';
import type { SearchInput } from '../types/SearchInput';

import { SearchResolver } from './SearchResolver';

/**
 * A text search scoped to events reaches events through their media.
 *
 * A photo's words live on its file/content rows; the event only dates it.
 * Before this, "squirrel" in the Events view found the messages containing the
 * word and none of the photos. The resolver now runs the same query over
 * content and files, maps the hits to their events, and merges them after the
 * direct hits — and the existing date filter still applies to them.
 */
const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;
const MESSAGE_ID = '019a0000-0000-7000-8000-000000000001';
const PHOTO_EVENT_ID = '019a0000-0000-7000-8000-000000000002';
const OLD_PHOTO_EVENT_ID = '019a0000-0000-7000-8000-000000000003';
const FILE_ID = '019a0000-0000-7000-8000-0000000000f1';

const IN_RANGE = new Date('2023-10-28T12:00:00Z');
const OUT_OF_RANGE = new Date('2019-01-01T12:00:00Z');

function makeResolver() {
  const search = jest.fn(async (_context: unknown, options: { includeTypes?: IndexableEntity[] }) => {
    if (options.includeTypes?.includes('content')) {
      return [{ type: 'file' as IndexableEntity, id: FILE_ID }];
    }

    return [{ type: 'communication' as IndexableEntity, id: MESSAGE_ID }];
  });
  const findEventIdsForMedia = jest.fn(async () => [PHOTO_EVENT_ID, OLD_PHOTO_EVENT_ID]);

  const entityResolutionService = {
    resolve: jest.fn(async (_context: unknown, identifiers: EntityIdentifier<IndexableEntity>[]) => {
      const map = new Map<string, unknown>();

      for (const identifier of identifiers) {
        if (identifier.type === 'communication') {
          map.set(`communication:${identifier.id}`, {
            type: 'communication',
            id: identifier.id,
            entity: { id: identifier.id, time: IN_RANGE, tags: [] },
          });
        }

        if (identifier.type === 'event') {
          map.set(`event:${identifier.id}`, {
            type: 'event',
            id: identifier.id,
            entity: {
              id: identifier.id,
              startTime: identifier.id === PHOTO_EVENT_ID ? IN_RANGE : OUT_OF_RANGE,
              tags: [],
            },
          });
        }
      }

      return map;
    }),
  };

  const empty = async () => [];
  const stub = (method: string) => ({
    [method]: jest.fn(empty),
    [method.replace('getEntitiesFor', 'countEntitiesFor')]: jest.fn(async () => 0),
  });

  const resolver = new SearchResolver(
    stub('getEntitiesForBrowserActivities') as never,
    stub('getEntitiesForCommunications') as never,
    stub('getEntitiesForConcepts') as never,
    { ...stub('getEntitiesForContents'), findEventIdsForMedia } as never,
    entityResolutionService as never,
    stub('getEntitiesForEvents') as never,
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
    { search } as never,
    { getEntitiesForTags: jest.fn(empty), searchByLabel: jest.fn(empty) } as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
  );

  return { resolver, search, findEventIdsForMedia };
}

function ids(page: { edges: Array<{ node: { id: string } }> }): string[] {
  return page.edges.map((edge) => GlobalUID.decode(edge.node.id).id);
}

describe('SearchResolver — events reached through matching media', () => {
  it('adds the events behind matching photos after the direct hits', async () => {
    const { resolver, search, findEventIdsForMedia } = makeResolver();

    const page = await resolver.search(CONTEXT, {
      query: 'squirrel',
      includeTypes: ['event', 'communication'],
      first: 10,
    } as SearchInput);

    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ query: 'squirrel', includeTypes: ['content', 'file'] }),
    );
    expect(findEventIdsForMedia).toHaveBeenCalledWith(expect.anything(), {
      contentIds: [],
      fileIds: [FILE_ID],
    });
    expect(ids(page)).toEqual([MESSAGE_ID, PHOTO_EVENT_ID, OLD_PHOTO_EVENT_ID]);
  });

  it('date-filters the expanded events like any other hit', async () => {
    const { resolver } = makeResolver();

    const page = await resolver.search(CONTEXT, {
      query: 'squirrel',
      includeTypes: ['event', 'communication'],
      startTime: '2023-10-21T00:00:00Z',
      endTime: '2023-11-06T23:59:59Z',
      first: 10,
    } as SearchInput);

    expect(ids(page)).toEqual([MESSAGE_ID, PHOTO_EVENT_ID]);
  });

  it('does not expand when events are out of scope', async () => {
    const { resolver, search, findEventIdsForMedia } = makeResolver();

    await resolver.search(CONTEXT, {
      query: 'squirrel',
      includeTypes: ['communication'],
      first: 10,
    } as SearchInput);

    expect(search).toHaveBeenCalledTimes(1);
    expect(findEventIdsForMedia).not.toHaveBeenCalled();
  });
});
