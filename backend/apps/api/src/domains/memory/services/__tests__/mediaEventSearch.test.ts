import type { UserServiceContext } from '@ci/common/context';

import { eventsForMatchingMedia, mergeIdentifiers, searchReachesEvents } from '../mediaEventSearch';

const CONTEXT = { userId: 'user-1' } as UserServiceContext;

describe('searchReachesEvents', () => {
  it('is true with no type scope at all', () => {
    expect(searchReachesEvents(undefined, undefined)).toBe(true);
    expect(searchReachesEvents([], [])).toBe(true);
  });

  it('follows an include list', () => {
    expect(searchReachesEvents(['event', 'communication'], undefined)).toBe(true);
    expect(searchReachesEvents(['content'], undefined)).toBe(false);
  });

  it('follows an exclude list', () => {
    expect(searchReachesEvents(undefined, ['content'])).toBe(true);
    expect(searchReachesEvents(undefined, ['event'])).toBe(false);
  });
});

describe('eventsForMatchingMedia', () => {
  it('searches content and files, then maps the hits to their events', async () => {
    const search = jest.fn(async () => [
      { type: 'file' as const, id: 'f1' },
      { type: 'content' as const, id: 'c1' },
      { type: 'file' as const, id: 'f2' },
    ]);
    const findEventIdsForMedia = jest.fn(async () => ['e1', 'e2']);

    const events = await eventsForMatchingMedia(
      { searchService: { search }, contentService: { findEventIdsForMedia } },
      CONTEXT,
      { query: 'squirrel', maxResults: 300 },
    );

    expect(search).toHaveBeenCalledWith(CONTEXT, {
      query: 'squirrel',
      maxResults: 300,
      includeTypes: ['content', 'file'],
    });
    expect(findEventIdsForMedia).toHaveBeenCalledWith(CONTEXT, { contentIds: ['c1'], fileIds: ['f1', 'f2'] });
    expect(events).toEqual([
      { type: 'event', id: 'e1' },
      { type: 'event', id: 'e2' },
    ]);
  });

  it('asks for the semantic mode when the caller did', async () => {
    const search = jest.fn(async () => []);

    await eventsForMatchingMedia(
      { searchService: { search }, contentService: { findEventIdsForMedia: jest.fn(async () => []) } },
      CONTEXT,
      { query: 'squirrel', semantic: true },
    );

    expect(search).toHaveBeenCalledWith(CONTEXT, expect.objectContaining({ mode: 'semantic' }));
  });
});

describe('mergeIdentifiers', () => {
  it('keeps direct hits first, in order, and appends only new expanded ones', () => {
    const direct = [
      { type: 'communication', id: 'm1' },
      { type: 'event', id: 'e1' },
    ];
    const expanded = [
      { type: 'event', id: 'e1' },
      { type: 'event', id: 'e2' },
    ];

    expect(mergeIdentifiers(direct, expanded)).toEqual([
      { type: 'communication', id: 'm1' },
      { type: 'event', id: 'e1' },
      { type: 'event', id: 'e2' },
    ]);
  });
});
