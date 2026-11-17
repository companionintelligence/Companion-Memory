/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { File, FileService } from '@ci/domains/files';
import type { SearchPage, SearchService } from '@ci/domains/search-next';

import { DatabaseSearchTool, describePage } from '../DatabaseSearchTool';
import { MediaFindPhotosTool } from '../MediaFindPhotosTool';

/**
 * The honest-count contract of the search intents. A full page of 100 used to
 * reach the model as a bare array, and "how many pictures of rabbits" came back
 * as 100 — the cap, not the corpus. These pin that the tool now says how big
 * the match set is, says when the page is only the top of it, and can answer
 * "how many" with a count(*) and no items at all.
 *
 * The second half pins the two ways the very next question died live
 * (2026-09-16): "how many photos in total" sent an empty query, and the retry
 * sent `countOnly: "true"` as a string. Both were schema rejections of a
 * request whose intent was not in doubt.
 */
const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;
const COVERAGE = { images: 22_870, described: 5_393 };

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;
}

function emptyResolver() {
  return { findByIds: jest.fn().mockResolvedValue([]) };
}

function fileServiceOf(options: { files?: File[]; coverage?: { images: number; described: number } } = {}) {
  return {
    findByIds: jest.fn().mockResolvedValue(options.files ?? []),
    describedImageCoverage: jest.fn().mockResolvedValue(options.coverage ?? COVERAGE),
  };
}

function makeTool(options: {
  search: Partial<Pick<SearchService, 'searchPage' | 'count' | 'recentPage' | 'hasSearchTerms' | 'countBy'>>;
  file?: ReturnType<typeof fileServiceOf>;
}) {
  const noop = emptyResolver();
  const file = options.file ?? fileServiceOf();

  const tool = new DatabaseSearchTool(
    noop as any,
    noop as any,
    noop as any,
    noop as any,
    { ...noop, findIdsByFileIds: jest.fn().mockResolvedValue(new Map()) } as any, // contentService
    noop as any,
    { findByIds: jest.fn().mockResolvedValue([]) } as any,
    file as unknown as FileService,
    noop as any,
    noop as any,
    noop as any,
    noop as any,
    noop as any,
    noop as any,
    noop as any,
    noop as any,
    options.search as SearchService,
    logger(),
  );

  return { tool, file };
}

function emptyPage(modeTaken: SearchPage['modeTaken']): SearchPage {
  return { items: [], totalMatches: 0, truncated: false, limit: 25, modeTaken };
}

/** A PlaceService with no place the query names, so media.findPhotos searches text as before. */
function noPlaces() {
  return { photosAtNamedPlace: jest.fn().mockResolvedValue({ places: [], fileIds: [], total: 0 }) } as never;
}

describe('DatabaseSearchTool — honest counts', () => {
  it('a cut keyword page reports the exact total and truncated, and the summary names the total', async () => {
    const photo = { id: 'f1', title: 'Rabbit in the garden' } as File;
    const page: SearchPage = {
      items: [{ type: 'file', id: 'f1' }],
      totalMatches: 342,
      truncated: true,
      limit: 1,
      modeTaken: 'keyword',
    };
    const searchPage = jest.fn().mockResolvedValue(page);
    const { tool } = makeTool({ search: { searchPage }, file: fileServiceOf({ files: [photo] }) });

    const result = await tool.execute(CONTEXT, { query: 'rabbit', entityTypes: ['file'], maxResults: 1 });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      totalMatches: 342,
      truncated: true,
      limit: 1,
      mode: 'keyword',
      items: [photo],
    });
    expect(result.data?.summary).toBe(
      'Showing the top 1 of 342 matches (exact count). Report the total, not the number shown.',
    );
    expect(searchPage).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      expect.objectContaining({ query: 'rabbit', includeTypes: ['file'], maxResults: 1 }),
    );
  });

  it('countOnly runs count() and returns the number with no items and no page', async () => {
    const count = jest.fn().mockResolvedValue(342);
    const searchPage = jest.fn();
    const { tool } = makeTool({ search: { count, searchPage } });

    const result = await tool.execute(CONTEXT, {
      query: 'rabbit',
      entityTypes: ['concept'],
      countOnly: true,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      summary: '342 concept entries match "rabbit" (exact count from the search index; no items returned).',
      totalMatches: 342,
      truncated: false,
      limit: 0,
      mode: 'count',
      items: [],
    });
    expect(count).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      { query: 'rabbit', includeTypes: ['concept'], showAgentTurnsFrom: [] },
    );
    expect(searchPage).not.toHaveBeenCalled();
  });

  it('a count over files carries description coverage, in the fields and in the sentence', async () => {
    const count = jest.fn().mockResolvedValue(1723);
    const { tool, file } = makeTool({ search: { count } });

    const result = await tool.execute(CONTEXT, { query: 'rabbit', entityTypes: ['file'], countOnly: true });

    expect(file.describedImageCoverage).toHaveBeenCalledWith({ userId: CONTEXT.userId });
    expect(result.data?.coverage).toEqual(COVERAGE);
    expect(result.data?.summary).toBe(
      '1723 file entries match "rabbit" (exact count from the search index; no items returned). ' +
        '5393 of 22870 photos have a generated description, and only described photos can match a ' +
        'subject word — treat subject counts as a floor.',
    );
  });

  it('a count with no query counts the whole scope instead of failing validation', async () => {
    const count = jest.fn().mockResolvedValue(23_592);
    const { tool } = makeTool({ search: { count } });

    const result = await tool.execute(CONTEXT, { entityTypes: ['file'], countOnly: true });

    expect(result.success).toBe(true);
    expect(count).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      { query: undefined, includeTypes: ['file'], showAgentTurnsFrom: [] },
    );
    expect(result.data?.totalMatches).toBe(23_592);
    expect(result.data?.summary).toMatch(/^23592 file entries in Memory \(exact count/);
  });

  it('a blank query on a count is the same as no query', async () => {
    const count = jest.fn().mockResolvedValue(7);
    const { tool } = makeTool({ search: { count } });

    const result = await tool.execute(CONTEXT, { query: '   ', entityTypes: ['file'], countOnly: true });

    expect(result.success).toBe(true);
    expect(count).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      { query: undefined, includeTypes: ['file'], showAgentTurnsFrom: [] },
    );
  });

  it("leaves agents' chats out unless the call asks for them", async () => {
    const searchPage = jest.fn().mockResolvedValue({
      items: [],
      totalMatches: 0,
      truncated: false,
      limit: 25,
      modeTaken: 'keyword',
    });
    const { tool } = makeTool({ search: { searchPage } });

    await tool.execute(CONTEXT, { query: 'email' });
    await tool.execute(CONTEXT, { query: 'email', includeAgentConversations: true });

    expect(searchPage.mock.calls[0][1]).toEqual(expect.objectContaining({ showAgentTurnsFrom: [] }));
    expect(searchPage.mock.calls[1][1]).not.toHaveProperty('showAgentTurnsFrom');
  });

  it('a page with no query lists the newest entries in scope instead of refusing', async () => {
    // "Most recent email" has no word in it. Required, the agent guessed "email" and answered with
    // the newest email that happened to contain the word (Hermes, 2026-11-16).
    const searchPage = jest.fn();
    const recentPage = jest.fn().mockResolvedValue(emptyPage('recent'));
    const { tool } = makeTool({ search: { searchPage, recentPage } });

    const result = await tool.execute(CONTEXT, { entityTypes: ['file'], sort: 'recent' });

    expect(result.success).toBe(true);
    expect(result.data?.mode).toBe('recent');
    expect(searchPage).not.toHaveBeenCalled();
    expect(recentPage).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      { includeTypes: ['file'], showAgentTurnsFrom: [], maxResults: undefined },
    );
  });

  it('communicationTypes scopes to communications of those kinds, on a page and on a count', async () => {
    const recentPage = jest.fn().mockResolvedValue(emptyPage('recent'));
    const count = jest.fn().mockResolvedValue(4);
    const { tool } = makeTool({ search: { recentPage, count } });

    await tool.execute(CONTEXT, { communicationTypes: ['email'], since: '2026-11-01' });
    await tool.execute(CONTEXT, { communicationTypes: ['email'], countOnly: true });

    expect(recentPage).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      {
        includeTypes: ['communication'],
        showAgentTurnsFrom: [],
        communicationTypes: ['email'],
        maxResults: undefined,
        since: new Date('2026-11-01'),
      },
    );
    expect(count).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      {
        query: undefined,
        includeTypes: ['communication'],
        showAgentTurnsFrom: [],
        communicationTypes: ['email'],
      },
    );
  });

  it('refuses a communication kind that does not exist', async () => {
    const { tool } = makeTool({ search: {} });

    const result = await tool.execute(CONTEXT, { communicationTypes: ['letter'] });

    expect(result.success).toBe(false);
  });

  it('a query of only common words lists the newest entries and says why, instead of an empty page', async () => {
    // "the", "your", "I" match nothing in the index; Hermes read those empty pages as "no mail".
    const searchPage = jest.fn().mockResolvedValue(emptyPage('keyword'));
    const hasSearchTerms = jest.fn().mockResolvedValue(false);
    const recentPage = jest.fn().mockResolvedValue({ ...emptyPage('recent'), totalMatches: 0 });
    const { tool } = makeTool({ search: { searchPage, hasSearchTerms, recentPage } });

    const result = await tool.execute(CONTEXT, {
      query: 'the',
      entityTypes: ['communication'],
      sort: 'recent',
    });

    expect(hasSearchTerms).toHaveBeenCalledWith('the');
    expect(recentPage).toHaveBeenCalledTimes(1);
    expect(result.data?.mode).toBe('recent');
    expect(result.data?.summary).toContain('"the" has only common words the search index ignores');
  });

  it('a real word that matched nothing stays an honest empty page', async () => {
    const searchPage = jest.fn().mockResolvedValue(emptyPage('keyword'));
    const hasSearchTerms = jest.fn().mockResolvedValue(true);
    const recentPage = jest.fn();
    const { tool } = makeTool({ search: { searchPage, hasSearchTerms, recentPage } });

    const result = await tool.execute(CONTEXT, { query: 'zebra', sort: 'recent' });

    expect(result.data?.totalMatches).toBe(0);
    expect(recentPage).not.toHaveBeenCalled();
  });

  it('a count of only common words counts the scope and says why', async () => {
    const count = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(79);
    const hasSearchTerms = jest.fn().mockResolvedValue(false);
    const { tool } = makeTool({ search: { count, hasSearchTerms } });

    const result = await tool.execute(CONTEXT, {
      query: 'your',
      entityTypes: ['communication'],
      countOnly: true,
    });

    expect(count).toHaveBeenLastCalledWith(
      { userId: CONTEXT.userId },
      { query: undefined, includeTypes: ['communication'], showAgentTurnsFrom: [] },
    );
    expect(result.data?.totalMatches).toBe(79);
    expect(result.data?.summary).toContain('"your" has only common words');
  });

  it('accepts countOnly as the string "true" — the spelling the local model actually sends', async () => {
    const count = jest.fn().mockResolvedValue(3);
    const searchPage = jest.fn();
    const { tool } = makeTool({ search: { count, searchPage } });

    const result = await tool.execute(CONTEXT, {
      query: 'rabbit',
      entityTypes: ['concept'],
      countOnly: 'true',
    });

    expect(result.success).toBe(true);
    expect(result.data?.mode).toBe('count');
    expect(searchPage).not.toHaveBeenCalled();
  });

  it('the string "false" is false, not truthy', async () => {
    const page: SearchPage = {
      items: [],
      totalMatches: 0,
      truncated: false,
      limit: 25,
      modeTaken: 'keyword',
    };
    const count = jest.fn();
    const searchPage = jest.fn().mockResolvedValue(page);
    const hasSearchTerms = jest.fn().mockResolvedValue(true);
    const { tool } = makeTool({ search: { count, searchPage, hasSearchTerms } });

    const result = await tool.execute(CONTEXT, { query: 'rabbit', countOnly: 'false' });

    expect(result.success).toBe(true);
    expect(result.data?.mode).toBe('keyword');
    expect(count).not.toHaveBeenCalled();
  });

  it('media.findPhotos passes countOnly through with the photo content scope fixed, query optional', async () => {
    const count = jest.fn().mockResolvedValue(5);
    const { tool: search } = makeTool({ search: { count } });
    const photos = new MediaFindPhotosTool(search, noPlaces(), logger());

    const withQuery = await photos.execute(CONTEXT, { query: 'rabbit', countOnly: true });
    const all = await photos.execute(CONTEXT, { countOnly: 'true' });

    expect(withQuery.success).toBe(true);
    expect(withQuery.data?.totalMatches).toBe(5);
    expect(withQuery.data?.coverage).toEqual(COVERAGE);
    expect(count).toHaveBeenNthCalledWith(
      1,
      { userId: CONTEXT.userId },
      { query: 'rabbit', includeTypes: ['content'], mediaContentOnly: true, showAgentTurnsFrom: [] },
    );
    // Says what was counted, and how many photos a subject word can see at all.
    expect(withQuery.data?.summary).toMatch(/^5 photos and videos match "rabbit"/);

    expect(all.success).toBe(true);
    expect(count).toHaveBeenNthCalledWith(
      2,
      { userId: CONTEXT.userId },
      { query: undefined, includeTypes: ['content'], mediaContentOnly: true, showAgentTurnsFrom: [] },
    );
  });

  it('groupBy answers "when do I most often" with counts per group, not a page', async () => {
    // OpenClaw paged 105 bird photos eight at a time to tally their hours and overflowed its
    // window (2026-11-16). The tally is a dozen numbers.
    const countBy = jest.fn().mockResolvedValue({
      groups: [
        { key: '10', count: 6 },
        { key: '14', count: 42 },
      ],
      undated: 2,
      total: 50,
      timeZone: 'America/Los_Angeles',
    });
    const searchPage = jest.fn();
    const hasSearchTerms = jest.fn().mockResolvedValue(true);
    const { tool } = makeTool({ search: { countBy, searchPage, hasSearchTerms } });

    const result = await tool.execute(CONTEXT, {
      query: 'bird',
      entityTypes: ['content'],
      groupBy: 'hour',
      since: '2026-01-01',
    });

    expect(result.success).toBe(true);
    expect(searchPage).not.toHaveBeenCalled();
    expect(countBy).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      {
        query: 'bird',
        includeTypes: ['content'],
        showAgentTurnsFrom: [],
        since: new Date('2026-01-01'),
        groupBy: 'hour',
      },
    );
    expect(result.data).toMatchObject({
      mode: 'count',
      totalMatches: 50,
      items: [],
      undated: 2,
      timeZone: 'America/Los_Angeles',
      groups: [
        { key: '10', count: 6 },
        { key: '14', count: 42 },
      ],
    });
    expect(result.data?.summary).toContain('The busiest hour of the day is 14:00 with 42.');
    expect(result.data?.summary).toContain('2 have no time of their own');
  });

  it('refuses a groupBy that is not a time bucket', async () => {
    const { tool } = makeTool({ search: {} });

    const result = await tool.execute(CONTEXT, { query: 'bird', groupBy: 'minute' });

    expect(result.success).toBe(false);
  });

  it('media.findPhotos takes since/until and groupBy, scoped to photo content, no query needed', async () => {
    const countBy = jest.fn().mockResolvedValue({ groups: [], undated: 0, total: 0, timeZone: 'UTC' });
    const recentPage = jest.fn().mockResolvedValue(emptyPage('recent'));
    const hasSearchTerms = jest.fn().mockResolvedValue(true);
    const { tool: search } = makeTool({ search: { countBy, recentPage, hasSearchTerms } });
    const places = noPlaces() as unknown as { photosAtNamedPlace: jest.Mock };
    const photos = new MediaFindPhotosTool(search, places as never, logger());

    const grouped = await photos.execute(CONTEXT, { query: 'Blue Bottle Coffee', groupBy: 'weekday' });
    const windowed = await photos.execute(CONTEXT, { since: '2026-04-01', until: '2026-04-30' });

    expect(grouped.success).toBe(true);
    expect(windowed.success).toBe(true);
    // A grouped count is always counts: no detour through the photos-at-a-place path.
    expect(places.photosAtNamedPlace).not.toHaveBeenCalled();
    expect(countBy).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      expect.objectContaining({ includeTypes: ['content'], mediaContentOnly: true, groupBy: 'weekday' }),
    );
    expect(recentPage).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      expect.objectContaining({
        includeTypes: ['content'],
        mediaContentOnly: true,
        since: new Date('2026-04-01'),
        until: new Date('2026-04-30'),
      }),
    );
  });

  it('media.findPhotos without countOnly still requires a query', async () => {
    const { tool: search } = makeTool({ search: { searchPage: jest.fn() } });
    const photos = new MediaFindPhotosTool(search, noPlaces(), logger());

    const result = await photos.execute(CONTEXT, {});

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/query is required/);
  });

  it('the summary counts what was hydrated, not what the index returned', () => {
    // Five hits, one dropped by its resolver: the model must not be told all five are shown.
    const page: SearchPage = {
      items: [],
      totalMatches: 5,
      truncated: false,
      limit: 25,
      modeTaken: 'keyword',
    };

    expect(describePage(page, 4)).toBe(
      'Showing the top 4 of 5 matches (exact count). Report the total, not the number shown.',
    );
    expect(describePage({ ...page, totalMatches: 4 }, 4)).toBe('4 matches; all shown.');
  });

  it('a full page from a mode that cannot count says "at least" and points at countOnly', () => {
    const full: SearchPage = {
      items: [],
      totalMatches: null,
      truncated: true,
      limit: 25,
      modeTaken: 'semantic',
    };
    const short: SearchPage = { ...full, truncated: false };

    expect(describePage(full, 25)).toBe(
      'Showing 25 results; the page came back full (cap 25), so there may be more. ' +
        'Say "at least" — or call again with countOnly: true for an exact count.',
    );
    expect(describePage(short, 3)).toBe('3 results; the search was not cut off.');
  });
});
