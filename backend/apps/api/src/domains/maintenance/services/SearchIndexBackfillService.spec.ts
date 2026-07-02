import { BrowserActivityCreatedEvent } from '@ci/domains/browser-activity/events';
import { FileCreatedEvent } from '@ci/domains/files/events';
import {
  CommunicationCreatedEvent,
  ContentCreatedEvent,
  EventCreatedEvent,
  ItemCreatedEvent,
} from '@ci/domains/memory/events';

import { SearchIndexBackfillService } from './SearchIndexBackfillService';

const SEARCH_INDEX_QUEUE = 'search-index';

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
  const sendMany = jest.fn(async () => undefined);
  const events = { sendMany } as const;
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new SearchIndexBackfillService(ds as any, events as any, logger as any);

  return { service, sendMany, ds };
}

describe('SearchIndexBackfillService', () => {
  it('bulk re-emits each type’s create events onto the search-index queue ONLY, with correct counts', async () => {
    const { service, sendMany } = makeService({
      communication: [['c1', 'c2'], []],
      event: [['e1'], []],
      content: [[], []],
      item: [['i1', 'i2', 'i3'], []],
      'browser-activity': [['b1'], []],
      file: [['f1', 'f2'], []],
    });

    const result = await service.backfill({ batchSize: 100 });

    expect(result).toEqual({
      enqueued: 9,
      perType: {
        communication: 2,
        event: 1,
        content: 0,
        item: 3,
        'browser-activity': 1,
        file: 2,
      },
    });

    // Each non-empty page is one bulk enqueue: (queue, [{name, data}, ...]).
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: CommunicationCreatedEvent, data: { communicationId: 'c1' } },
      { name: CommunicationCreatedEvent, data: { communicationId: 'c2' } },
    ]);
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: EventCreatedEvent, data: { eventId: 'e1' } },
    ]);
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: ItemCreatedEvent, data: { itemId: 'i1' } },
      { name: ItemCreatedEvent, data: { itemId: 'i2' } },
      { name: ItemCreatedEvent, data: { itemId: 'i3' } },
    ]);
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: BrowserActivityCreatedEvent, data: { browserActivityId: 'b1' } },
    ]);
    // file rows (the file-embedding backfill, #1605) ride the same bulk path.
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: FileCreatedEvent, data: { fileId: 'f1' } },
      { name: FileCreatedEvent, data: { fileId: 'f2' } },
    ]);

    // content had an empty page — never enqueued — and nothing left the search-index queue.
    const contentEmitted = sendMany.mock.calls.some((call) =>
      ((call as unknown[])[1] as Array<{ name: string }>).some((e) => e.name === ContentCreatedEvent),
    );
    expect(contentEmitted).toBe(false);
    for (const call of sendMany.mock.calls) {
      expect((call as unknown[])[0]).toBe(SEARCH_INDEX_QUEUE);
    }
  });

  it('keyset-pages until a short page, advancing the cursor by the last id', async () => {
    const { service, sendMany, ds } = makeService({
      communication: [['c1', 'c2'], ['c3'], []],
    });

    const result = await service.backfill({ entityTypes: ['communication'], batchSize: 2 });

    expect(result.enqueued).toBe(3);
    // page 1 after=null, page 2 after='c2' (last of page 1), page 3 after='c3'.
    const comCalls = ds.calls.filter((c) => c.entityType === 'communication');
    expect(comCalls.map((c) => c.after)).toEqual([null, 'c2', 'c3']);
    // one bulk enqueue per non-empty page (the empty page 3 enqueues nothing).
    expect(sendMany).toHaveBeenCalledTimes(2);
  });

  it('caps emission at limitPerType and stops paging that type', async () => {
    const { service, sendMany } = makeService({
      communication: [['c1', 'c2', 'c3', 'c4', 'c5'], ['c6']],
    });

    const result = await service.backfill({
      entityTypes: ['communication'],
      batchSize: 5,
      limitPerType: 2,
    });

    expect(result.enqueued).toBe(2);
    // the first page is trimmed to the cap and enqueued once; paging then stops.
    expect(sendMany).toHaveBeenCalledTimes(1);
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: CommunicationCreatedEvent, data: { communicationId: 'c1' } },
      { name: CommunicationCreatedEvent, data: { communicationId: 'c2' } },
    ]);
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
