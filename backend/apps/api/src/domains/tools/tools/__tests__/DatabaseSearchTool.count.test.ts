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
  search: Partial<Pick<SearchService, 'searchPage' | 'count'>>;
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

/** A PlaceService with no place the query names, so media.findPhotos searches text as before. */
function noPlaces() {
  return { photosAtNamedPlace: jest.fn().mockResolvedValue({ places: [], fileIds: [] }) } as never;
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
      { query: 'rabbit', includeTypes: ['concept'] },
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
      { query: undefined, includeTypes: ['file'] },
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
      { query: undefined, includeTypes: ['file'] },
    );
  });

  it('a page still requires a query — there is nothing to rank without one', async () => {
    const searchPage = jest.fn();
    const { tool } = makeTool({ search: { searchPage } });

    const result = await tool.execute(CONTEXT, { entityTypes: ['file'] });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/query is required unless countOnly is true/);
    expect(searchPage).not.toHaveBeenCalled();
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
    const { tool } = makeTool({ search: { count, searchPage } });

    const result = await tool.execute(CONTEXT, { query: 'rabbit', countOnly: 'false' });

    expect(result.success).toBe(true);
    expect(result.data?.mode).toBe('keyword');
    expect(count).not.toHaveBeenCalled();
  });

  it('media.findPhotos passes countOnly through with the file scope fixed, query optional', async () => {
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
      { query: 'rabbit', includeTypes: ['file'] },
    );

    expect(all.success).toBe(true);
    expect(count).toHaveBeenNthCalledWith(
      2,
      { userId: CONTEXT.userId },
      { query: undefined, includeTypes: ['file'] },
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
