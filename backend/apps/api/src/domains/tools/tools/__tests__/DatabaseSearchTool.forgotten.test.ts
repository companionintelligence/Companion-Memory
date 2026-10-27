/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { SearchService } from '@ci/domains/search-next';

import { DatabaseSearchTool } from '../DatabaseSearchTool';

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

function resolverOf(rows: Array<Record<string, unknown>>) {
  return { findByIds: jest.fn().mockResolvedValue(rows) };
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

describe('DatabaseSearchTool forgotten entities', () => {
  it('leaves out the people, places and concepts the user asked Memory to forget, even while an index row still finds them', async () => {
    const noop = resolverOf([]);
    const people = resolverOf([
      { id: 'jane', name: 'Jane Smith', isActive: false },
      { id: 'john', name: 'John Doe', isActive: true },
    ]);
    const places = resolverOf([{ id: 'cabin', name: 'Ravenwood Cottage', isActive: false }]);
    const concepts = resolverOf([{ id: 'quill', name: 'Quillfeather Project', isActive: false }]);
    const search = searchOf([
      { type: 'person', id: 'jane' },
      { type: 'person', id: 'john' },
      { type: 'place', id: 'cabin' },
      { type: 'concept', id: 'quill' },
    ]);

    const tool = new DatabaseSearchTool(
      noop as any, // answerService
      noop as any, // browserActivityService
      noop as any, // communicationService
      concepts as any,
      noop as any, // contentService
      noop as any, // eventService
      noop as any, // fileChunkService
      noop as any, // fileService
      noop as any, // itemService
      noop as any, // noteService
      people as any,
      places as any,
      noop as any, // productModelService
      noop as any, // receiptService
      noop as any, // taskService
      noop as any, // threadService
      search,
      logger(),
    );

    const result = await tool.execute(CONTEXT, { query: 'cabin' });

    expect(result.success).toBe(true);
    expect(result.data?.items.map((item: { type: string; id: string }) => `${item.type}:${item.id}`)).toEqual(
      ['person:john'],
    );
  });
});
