import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { queryNamesPlace } from '@ci/domains/memory';

import type { DatabaseSearchTool } from '../DatabaseSearchTool';
import { MediaFindPhotosTool } from '../MediaFindPhotosTool';

/**
 * "Show me photos from Blue Bottle Coffee" found none: the place was named on
 * the Places page from seven photos taken there, but a photo's search row is its
 * file name and description, which never name the place, and the photo events
 * carry GPS with no link to the place. With descriptions it was worse in a
 * quieter way: eleven hits on "blue" and "coffee", four of them taken there.
 */
const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;
const BLUE_BOTTLE = { id: 'place-1', name: 'Blue Bottle Coffee' };
const AT_PLACE = ['f7', 'f6', 'f5', 'f4', 'f3', 'f2', 'f1'];

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as never;
}

function makeTool(atPlace: { places: Array<{ id: string; name: string }>; fileIds: string[] }) {
  const search = {
    run: jest.fn().mockResolvedValue({
      summary: 'text search',
      totalMatches: 0,
      truncated: false,
      limit: 25,
      mode: 'keyword',
      items: [],
    }),
    resolveFileHits: jest.fn(async (_context: unknown, ids: string[]) =>
      ids.map((id) => ({ id, filename: `${id}.jpg`, type: 'file', link: `/content/c-${id}` })),
    ),
  };
  const places = { photosAtNamedPlace: jest.fn().mockResolvedValue(atPlace) };
  const tool = new MediaFindPhotosTool(search as unknown as DatabaseSearchTool, places as never, logger());

  return { tool, search, places };
}

describe('media.findPhotos for a named place', () => {
  it('answers with the photos taken there, newest first, without a text search', async () => {
    const { tool, search, places } = makeTool({ places: [BLUE_BOTTLE], fileIds: AT_PLACE });

    const result = await tool.execute(CONTEXT, { query: 'Blue Bottle Coffee' });

    expect(places.photosAtNamedPlace).toHaveBeenCalledWith({ userId: CONTEXT.userId }, 'Blue Bottle Coffee');
    expect(search.run).not.toHaveBeenCalled();
    expect(result.data?.mode).toBe('place');
    expect(result.data?.totalMatches).toBe(7);
    expect(result.data?.truncated).toBe(false);
    expect(result.data?.items.map((item) => item.id)).toEqual(AT_PLACE);
    expect(result.data?.summary).toBe(
      '7 photos and videos taken at Blue Bottle Coffee, found by where each was taken; all shown, newest first.',
    );
  });

  it('caps the page at maxResults and reports the total', async () => {
    const { tool, search } = makeTool({ places: [BLUE_BOTTLE], fileIds: AT_PLACE });

    const result = await tool.execute(CONTEXT, { query: 'Blue Bottle Coffee', maxResults: 3 });

    expect(search.resolveFileHits).toHaveBeenCalledWith(expect.anything(), ['f7', 'f6', 'f5']);
    expect(result.data?.totalMatches).toBe(7);
    expect(result.data?.truncated).toBe(true);
    expect(result.data?.summary).toMatch(
      /^Showing the newest 3 of 7 photos and videos taken at Blue Bottle Coffee/,
    );
  });

  it('counts them for "how many"', async () => {
    const { tool, search } = makeTool({ places: [BLUE_BOTTLE], fileIds: AT_PLACE });

    const result = await tool.execute(CONTEXT, { query: 'Blue Bottle Coffee', countOnly: true });

    expect(search.resolveFileHits).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ totalMatches: 7, mode: 'count', items: [] });
    expect(result.data?.summary).toMatch(/^7 photos and videos were taken at Blue Bottle Coffee/);
  });

  it('searches the text as before when no place is named, or none of its photos were taken there', async () => {
    for (const atPlace of [
      { places: [], fileIds: [] },
      { places: [BLUE_BOTTLE], fileIds: [] },
    ]) {
      const { tool, search } = makeTool(atPlace);

      const result = await tool.execute(CONTEXT, { query: 'rabbit' });

      expect(search.run).toHaveBeenCalledWith(expect.anything(), {
        query: 'rabbit',
        maxResults: undefined,
        countOnly: undefined,
        entityTypes: ['file'],
      });
      expect(result.data?.mode).toBe('keyword');
    }
  });

  it('does not look for a place when counting every photo', async () => {
    const { tool, places, search } = makeTool({ places: [], fileIds: [] });

    await tool.execute(CONTEXT, { countOnly: true });

    expect(places.photosAtNamedPlace).not.toHaveBeenCalled();
    expect(search.run).toHaveBeenCalled();
  });
});

describe('queryNamesPlace', () => {
  it('matches the whole name as whole words anywhere in the query', () => {
    expect(queryNamesPlace('Blue Bottle Coffee', 'Blue Bottle Coffee')).toBe(true);
    expect(queryNamesPlace('photos from blue bottle coffee', 'Blue Bottle Coffee')).toBe(true);
    expect(queryNamesPlace('Blue Bottle Coffee, SF', 'Blue Bottle Coffee')).toBe(true);
    expect(queryNamesPlace('Café Réveille', 'Cafe Reveille')).toBe(true);
  });

  it('does not match part of a name, a word inside another word, or a very short name', () => {
    expect(queryNamesPlace('Blue Bottle', 'Blue Bottle Coffee')).toBe(false);
    expect(queryNamesPlace('coffee', 'Blue Bottle Coffee')).toBe(false);
    expect(queryNamesPlace('homemade bread', 'Home')).toBe(false);
    expect(queryNamesPlace('at the gym', 'Gy')).toBe(false);
  });
});
