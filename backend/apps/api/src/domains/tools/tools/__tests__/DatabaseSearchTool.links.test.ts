/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { SearchService } from '@ci/domains/search-next';

import { DatabaseSearchTool, itemLink } from '../DatabaseSearchTool';

const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;

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

function searchOf(items: { type: string; id: string }[]): SearchService {
  return {
    searchPage: jest.fn().mockResolvedValue({
      items,
      totalMatches: items.length,
      truncated: false,
      limit: 25,
      modeTaken: 'keyword',
    }),
  } as unknown as SearchService;
}

function makeTool(options: {
  search: SearchService;
  files?: { findByIds: jest.Mock };
  content?: { findByIds: jest.Mock; findIdsByFileIds: jest.Mock };
  people?: { findByIds: jest.Mock };
}) {
  const noop = emptyResolver();

  return new DatabaseSearchTool(
    noop as any, // answerService
    noop as any, // browserActivityService
    noop as any, // communicationService
    noop as any, // conceptService
    (options.content ?? { ...emptyResolver(), findIdsByFileIds: jest.fn() }) as any,
    noop as any, // eventService
    { findByIds: jest.fn().mockResolvedValue([]) } as any, // fileChunkService
    (options.files ?? noop) as any,
    noop as any, // itemService
    noop as any, // noteService
    (options.people ?? noop) as any,
    noop as any, // placeService
    noop as any, // productModelService
    noop as any, // receiptService
    noop as any, // taskService
    noop as any, // threadService
    options.search,
    logger(),
  );
}

describe('itemLink', () => {
  const none = new Map<string, string[]>();

  it('opens a typed entity at its page by raw id', () => {
    expect(itemLink('person', 'p1', none)).toBe('/people/p1');
    expect(itemLink('event', 'e1', none)).toBe('/events/e1');
    expect(itemLink('content', 'c1', none)).toBe('/content/c1');
  });

  it('routes a file through its content row, since a file has no page of its own', () => {
    expect(itemLink('file', 'f1', new Map([['f1', ['c1', 'c2']]]))).toBe('/content/c1');
  });

  it('gives no link to a file without a content row, rather than a path that 404s', () => {
    expect(itemLink('file', 'f1', none)).toBeUndefined();
  });

  it('gives no link to a type with no page', () => {
    expect(itemLink('thread', 't1', none)).toBeUndefined();
    expect(itemLink('browser-activity', 'b1', none)).toBeUndefined();
  });
});

describe('DatabaseSearchTool — item links', () => {
  it('stamps every hit with its type and a link when one exists', async () => {
    const photo = { id: 'f1', filename: 'IMG_1.jpg', title: 'Squirrel on Fence' };
    const person = { id: 'p1', name: 'Ada' };
    const search = searchOf([
      { type: 'file', id: 'f1' },
      { type: 'person', id: 'p1' },
    ]);
    const content = {
      ...emptyResolver(),
      findIdsByFileIds: jest.fn().mockResolvedValue(new Map([['f1', ['c1']]])),
    };
    const tool = makeTool({
      search,
      files: { findByIds: jest.fn().mockResolvedValue([photo]) },
      people: { findByIds: jest.fn().mockResolvedValue([person]) },
      content,
    });

    const result = await tool.execute(CONTEXT, { query: 'squirrel' });

    expect(result.success).toBe(true);
    expect(result.data?.items).toEqual([
      { ...photo, type: 'file', link: '/content/c1' },
      { ...person, type: 'person', link: '/people/p1' },
    ]);
    expect(content.findIdsByFileIds).toHaveBeenCalledWith({ userId: CONTEXT.userId }, ['f1']);
  });

  it('omits the link key, not the hit, for a file with no content row', async () => {
    const photo = { id: 'f1', filename: 'IMG_1.jpg' };
    const content = { ...emptyResolver(), findIdsByFileIds: jest.fn().mockResolvedValue(new Map()) };
    const tool = makeTool({
      search: searchOf([{ type: 'file', id: 'f1' }]),
      files: { findByIds: jest.fn().mockResolvedValue([photo]) },
      content,
    });

    const result = await tool.execute(CONTEXT, { query: 'anything' });

    expect(result.data?.items).toEqual([{ ...photo, type: 'file' }]);
    expect(result.data?.items[0]).not.toHaveProperty('link');
  });

  it('does not look up content rows when no file hit hydrated', async () => {
    const content = { ...emptyResolver(), findIdsByFileIds: jest.fn() };
    const tool = makeTool({
      search: searchOf([{ type: 'file', id: 'missing' }]),
      files: { findByIds: jest.fn().mockResolvedValue([null]) },
      content,
    });

    const result = await tool.execute(CONTEXT, { query: 'anything' });

    expect(result.data?.items).toEqual([]);
    expect(content.findIdsByFileIds).not.toHaveBeenCalled();
  });
});
