import { BrowserActivityCreatedEvent } from '@ci/domains/browser-activity/events';
import {
  CommunicationCreatedEvent,
  ContentCreatedEvent,
  EventCreatedEvent,
  ItemCreatedEvent,
} from '@ci/domains/memory/events';

import { SearchIndexBackfillService } from './SearchIndexBackfillService';

const SEARCH_INDEX = { queue: 'search-index' };

/**
 * Build a DataSource whose `query` serves a queue of id pages PER entity type
 * (keyed on params[0] = the entity_type), exhausting to [] so the keyset loop
 * terminates. Records every SELECT so paging can be asserted.
 */
function makeDataSource(pagesByType: Record<string, string[][]>) {
  const calls: Array<{ entityType: string; after: string | null; limit: number }> = [];
  const cursors: Record<string, number> = {};

  const query = jest.fn(async (_sql: string, params: unknown[]) => {
    const entityType = params[0] as string;
    const after = (params[1] ?? null) as string | null;
    const limit = params[2] as number;
    calls.push({ entityType, after, limit });

    const pages = pagesByType[entityType] ?? [];
    const idx = cursors[entityType] ?? 0;
    cursors[entityType] = idx + 1;
    const page = pages[idx] ?? [];

    return page.map((id) => ({ id }));
  });

  return { query, calls } as const;
}

function makeService(pagesByType: Record<string, string[][]>) {
  const ds = makeDataSource(pagesByType);
  const send = jest.fn(async () => ['job-id']);
  const events = { send } as const;
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new SearchIndexBackfillService(ds as any, events as any, logger as any);

  return { service, send, ds };
}

describe('SearchIndexBackfillService', () => {
  it('re-emits each type’s create event onto the search-index queue ONLY, with correct counts', async () => {
    const { service, send } = makeService({
      communication: [['c1', 'c2'], []],
      event: [['e1'], []],
      content: [[], []],
      item: [['i1', 'i2', 'i3'], []],
      'browser-activity': [['b1'], []],
    });

    const result = await service.backfill({ batchSize: 100 });

    expect(result).toEqual({
      enqueued: 7,
      perType: { communication: 2, event: 1, content: 0, item: 3, 'browser-activity': 1 },
    });

    // Correct event name + payload field per type, all scoped to search-index.
    expect(send).toHaveBeenCalledWith(CommunicationCreatedEvent, { communicationId: 'c1' }, SEARCH_INDEX);
    expect(send).toHaveBeenCalledWith(EventCreatedEvent, { eventId: 'e1' }, SEARCH_INDEX);
    expect(send).toHaveBeenCalledWith(ItemCreatedEvent, { itemId: 'i3' }, SEARCH_INDEX);
    expect(send).toHaveBeenCalledWith(BrowserActivityCreatedEvent, { browserActivityId: 'b1' }, SEARCH_INDEX);
    expect(send).not.toHaveBeenCalledWith(ContentCreatedEvent, expect.anything(), expect.anything());

    // Every emission targeted the search-index queue (3rd arg of every send call).
    for (const call of send.mock.calls) {
      expect((call as unknown[])[2]).toEqual(SEARCH_INDEX);
    }
  });

  it('keyset-pages until a short page, advancing the cursor by the last id', async () => {
    const { service, send, ds } = makeService({
      communication: [['c1', 'c2'], ['c3'], []],
    });

    const result = await service.backfill({ entityTypes: ['communication'], batchSize: 2 });

    expect(result.enqueued).toBe(3);
    // page 1 after=null, page 2 after='c2' (last of page 1), page 3 after='c3'.
    const comCalls = ds.calls.filter((c) => c.entityType === 'communication');
    expect(comCalls.map((c) => c.after)).toEqual([null, 'c2', 'c3']);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('caps emission at limitPerType and stops paging that type', async () => {
    const { service, send } = makeService({
      communication: [['c1', 'c2', 'c3', 'c4', 'c5'], ['c6']],
    });

    const result = await service.backfill({
      entityTypes: ['communication'],
      batchSize: 5,
      limitPerType: 2,
    });

    expect(result.enqueued).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('only sweeps the requested entity types', async () => {
    const { service, ds } = makeService({
      communication: [['c1'], []],
      item: [['i1'], []],
    });

    await service.backfill({ entityTypes: ['item'], batchSize: 10 });

    const sweptTypes = new Set(ds.calls.map((c) => c.entityType));
    expect(sweptTypes).toEqual(new Set(['item']));
  });
});
