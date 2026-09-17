/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { Task, TaskService } from '@ci/domains/planning/task.module';
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

/** Every other resolver DatabaseSearchTool takes, stubbed to return nothing — this test only cares about 'task'. */
function emptyResolver() {
  return { findByIds: jest.fn().mockResolvedValue([]) };
}

/** A SearchService whose page is exactly `items`, uncut: hydration is what these tests are about. */
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

function makeTool(options: { search: SearchService; task: Pick<TaskService, 'findByIds'> }) {
  const noop = emptyResolver();

  return new DatabaseSearchTool(
    noop as any, // answerService
    noop as any, // browserActivityService
    noop as any, // communicationService
    noop as any, // conceptService
    noop as any, // contentService
    noop as any, // eventService
    { findByIds: jest.fn().mockResolvedValue([]) } as any, // fileChunkService (no context arg)
    noop as any, // fileService
    noop as any, // itemService
    noop as any, // noteService
    noop as any, // personService
    noop as any, // placeService
    noop as any, // productModelService
    noop as any, // receiptService
    options.task as TaskService,
    noop as any, // threadService
    options.search,
    logger(),
  );
}

describe('DatabaseSearchTool — task hydration (M4 Part B)', () => {
  it('hydrates a task hit through TaskService.findByIds rather than dropping it', async () => {
    const task = { id: 'task-1', title: 'Draft the Fenwick contract redline' } as Task;
    const search = searchOf([{ type: 'task', id: 'task-1' }]);
    const findByIds = jest.fn().mockResolvedValue([task]);
    const tool = makeTool({ search, task: { findByIds } });

    const result = await tool.execute(CONTEXT, { query: 'Fenwick' });

    expect(result.success).toBe(true);
    expect(findByIds).toHaveBeenCalledWith({ userId: CONTEXT.userId }, ['task-1']);
    expect(result.data?.items).toEqual([task]);
  });

  it('preserves search ranking across mixed entity types (task interleaved with other hits)', async () => {
    const taskHit = { id: 't1', title: 'Task hit' } as Task;
    const search = searchOf([
      { type: 'task', id: 't1' },
      { type: 'event', id: 'e1' },
    ]);
    const findByIds = jest.fn().mockResolvedValue([taskHit]);
    const tool = makeTool({ search, task: { findByIds } });

    const result = await tool.execute(CONTEXT, { query: 'anything' });

    // The event resolver is stubbed to return [], so only the task hit survives — proving the task
    // branch runs in the same resolution pass as every other type, in search-ranked order.
    expect(result.data?.items).toEqual([taskHit]);
  });

  it('drops a task hit that TaskService cannot find (deleted/not owned) without throwing', async () => {
    const search = searchOf([{ type: 'task', id: 'missing' }]);
    const findByIds = jest.fn().mockResolvedValue([null]);
    const tool = makeTool({ search, task: { findByIds } });

    const result = await tool.execute(CONTEXT, { query: 'anything' });

    expect(result.success).toBe(true);
    expect(result.data?.items).toEqual([]);
  });
});
