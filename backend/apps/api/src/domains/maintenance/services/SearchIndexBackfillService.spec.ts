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
function makeDataSource(
  pagesByType: Record<string, string[][]>,
  embeddedByType: Record<string, number> = {},
) {
  const calls: Array<{ entityType: string; after: string | null; afterTs?: string | null; limit: number }> =
    [];
  const cursors: Record<string, number> = {};

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    // The pending-depth probe binds no params (reads pgboss.job); answer 0 so
    // sweeps proceed by default — guard tests override with mockImplementationOnce.
    if (!params) {
      return [{ count: '0' }];
    }

    // The embedded-count probe binds one param (entity_type) and reads
    // ci_search.embeddings; answer the configured drain count for that type.
    if (/FROM ci_search\.embeddings/i.test(sql)) {
      const entityType = params[0] as string;

      return [{ count: String(embeddedByType[entityType] ?? 0) }];
    }

    // Time-paged (hypertable) types bind 4 params (type, afterTs, afterId, limit);
    // plain uuid keysets bind 3 (type, afterId, limit).
    const timePaged = params.length === 4;
    const entityType = params[0] as string;
    const after = ((timePaged ? params[2] : params[1]) ?? null) as string | null;
    const afterTs = timePaged ? ((params[1] ?? null) as string | null) : undefined;
    const limit = (timePaged ? params[3] : params[2]) as number;
    calls.push({ entityType, after, afterTs, limit });

    const pages = pagesByType[entityType] ?? [];
    const idx = cursors[entityType] ?? 0;
    cursors[entityType] = idx + 1;
    const page = pages[idx] ?? [];

    // Time-paged rows carry the ORDER BY timestamp alongside the id.
    return page.map((id) => (timePaged ? { id, ts: `ts-${id}` } : { id }));
  });

  return { query, calls } as const;
}

function makeService(pagesByType: Record<string, string[][]>, embeddedByType: Record<string, number> = {}) {
  const ds = makeDataSource(pagesByType, embeddedByType);
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
      // No embeddings configured for this DS → drain count is 0 for every type.
      embedded: 0,
      embeddedPerType: {
        communication: 0,
        event: 0,
        content: 0,
        item: 0,
        'browser-activity': 0,
        file: 0,
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

  it('surfaces the embedded (drain) count per type and in total, alongside enqueued', async () => {
    // 3 comms still missing an embedding get enqueued; the drain has already
    // indexed 100 comms + 5 events by the time the response is built.
    const { service } = makeService(
      { communication: [['c1', 'c2', 'c3'], []], event: [[], []] },
      { communication: 100, event: 5 },
    );

    const result = await service.backfill({ entityTypes: ['communication', 'event'], batchSize: 100 });

    expect(result.enqueued).toBe(3);
    expect(result.embedded).toBe(105);
    expect(result.embeddedPerType).toEqual({ communication: 100, event: 5 });
  });

  it('reports the embedded count even on a queue_backlog skip so a stalled drain stays visible', async () => {
    const { service, sendMany, ds } = makeService({ communication: [['c1'], []] }, { communication: 42 });
    // First query is the pending-depth probe → over threshold, so the sweep skips
    // enqueue but still samples the drain count.
    ds.query.mockImplementationOnce(async () => [{ count: '999999' }]);

    const result = await service.backfill({ entityTypes: ['communication'], batchSize: 10 });

    expect(result.skipped).toBe('queue_backlog');
    expect(result.enqueued).toBe(0);
    expect(result.embedded).toBe(42);
    expect(result.embeddedPerType).toEqual({ communication: 42 });
    expect(sendMany).not.toHaveBeenCalled();
  });

  it('keyset-pages plain uuid tables until a short page, advancing the cursor by the last id', async () => {
    const { service, sendMany, ds } = makeService({
      content: [['c1', 'c2'], ['c3'], []],
    });

    const result = await service.backfill({ entityTypes: ['content'], batchSize: 2 });

    expect(result.enqueued).toBe(3);
    // page 1 after=null, page 2 after='c2' (last of page 1), page 3 after='c3'.
    const contentCalls = ds.calls.filter((c) => c.entityType === 'content');
    expect(contentCalls.map((c) => c.after)).toEqual([null, 'c2', 'c3']);
    // one bulk enqueue per non-empty page (the empty page 3 enqueues nothing).
    expect(sendMany).toHaveBeenCalledTimes(2);
  });

  it('time-pages hypertable-backed communications on the composite (time, id) cursor', async () => {
    const { service, ds } = makeService({
      communication: [['c1', 'c2'], ['c3'], []],
    });

    const result = await service.backfill({ entityTypes: ['communication'], batchSize: 2 });

    expect(result.enqueued).toBe(3);
    // Both cursor halves advance together: (afterTs, afterId) from the last row.
    const comCalls = ds.calls.filter((c) => c.entityType === 'communication');
    expect(comCalls.map((c) => [c.afterTs ?? null, c.after])).toEqual([
      [null, null],
      ['ts-c2', 'c2'],
      ['ts-c3', 'c3'],
    ]);
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

  it('anti-joins ci_search.index_skips in BOTH query branches so skip-marked rows never re-enqueue', async () => {
    const { service, ds } = makeService({
      communication: [['c1'], []], // time-paged (hypertable) branch
      content: [['c2'], []], // plain uuid-keyset branch
    });

    await service.backfill({ entityTypes: ['communication', 'content'], batchSize: 10 });

    expect(ds.query.mock.calls.length).toBeGreaterThan(0);
    let pageQueriesSeen = 0;
    for (const [sql, params] of ds.query.mock.calls) {
      if (!params) {
        continue;
      } // the pending-depth probe reads pgboss.job, not a source table

      const flat = (sql as string).replace(/\s+/g, ' ');
      if (/FROM ci_search\.embeddings/i.test(flat)) {
        continue;
      } // the embedded-count probe reads ci_search.embeddings, not a source table

      pageQueriesSeen += 1;
      expect(flat).toContain('LEFT JOIN ci_search.index_skips k');
      expect(flat).toContain('k.entity_id IS NULL');
    }

    expect(pageQueriesSeen).toBeGreaterThan(0);
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

  it('omits the errors field entirely on a clean sweep', async () => {
    const { service } = makeService({ communication: [['c1'], []] });

    const result = await service.backfill({ entityTypes: ['communication'], batchSize: 10 });

    expect(result.errors).toBeUndefined();
  });

  it('fail-soft: a mid-sweep enqueue failure keeps the pages already enqueued, reports the error, and continues with the remaining types', async () => {
    const { service, sendMany } = makeService({
      communication: [['c1', 'c2'], ['c3'], []],
      item: [['i1'], []],
    });
    // Page 1 of communication enqueues fine; page 2 blows up (e.g. connection
    // drop inside a pg-boss insert chunk); item must still be swept afterwards.
    sendMany
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockResolvedValue(undefined);

    const result = await service.backfill({ entityTypes: ['communication', 'item'], batchSize: 2 });

    // The 2 rows of page 1 are real jobs — counted, not lost.
    expect(result.perType.communication).toBe(2);
    expect(result.errors).toEqual({ communication: 'connection terminated' });
    // The failure did not abort the sweep: item completed normally.
    expect(result.perType.item).toBe(1);
    expect(result.enqueued).toBe(3);
  });

  it('skips the sweep when another one is already running in-process', async () => {
    const { service, sendMany } = makeService({ communication: [['c1'], []] });
    // Hold the first sweep open mid-enqueue so the second call overlaps it.
    let release: (() => void) | undefined;
    sendMany.mockImplementationOnce(
      () =>
        new Promise<undefined>((res) => {
          release = () => res(undefined);
        }),
    );

    const first = service.backfill({ entityTypes: ['communication'], batchSize: 10, pendingThreshold: 0 });
    // Wait until the first sweep actually reaches the held sendMany (several
    // awaits deep); the lock itself is set synchronously at entry.
    while (release === undefined) {
      await new Promise((r) => setTimeout(r, 0));
    }

    const second = await service.backfill({
      entityTypes: ['communication'],
      batchSize: 10,
      pendingThreshold: 0,
    });

    expect(second).toEqual({
      enqueued: 0,
      perType: {},
      embedded: 0,
      embeddedPerType: { communication: 0 },
      skipped: 'already_running',
    });

    release();
    const firstResult = await first;
    expect(firstResult.enqueued).toBe(1);

    // The lock is released after the sweep — a later run proceeds normally.
    const third = await service.backfill({
      entityTypes: ['communication'],
      batchSize: 10,
      pendingThreshold: 0,
    });
    expect(third.skipped).toBeUndefined();
  });

  it('skips the sweep when the queue backlog exceeds pendingThreshold', async () => {
    const { service, sendMany, ds } = makeService({ communication: [['c1'], []] });
    // The FIRST dataSource.query call is the pending-depth probe; the page
    // queries only run when the sweep proceeds.
    ds.query.mockImplementationOnce(async () => [{ count: '123456' }]);

    const result = await service.backfill({ entityTypes: ['communication'], batchSize: 10 });

    expect(result).toEqual({
      enqueued: 0,
      perType: {},
      embedded: 0,
      embeddedPerType: { communication: 0 },
      skipped: 'queue_backlog',
      pending: 123456,
    });
    expect(sendMany).not.toHaveBeenCalled();
  });

  it('proceeds when the backlog is under the threshold (and when the guard is disabled)', async () => {
    const under = makeService({ communication: [['c1'], []] });
    under.ds.query.mockImplementationOnce(async () => [{ count: '10' }]);
    const r1 = await under.service.backfill({ entityTypes: ['communication'], batchSize: 10 });
    expect(r1.skipped).toBeUndefined();
    expect(r1.enqueued).toBe(1);

    const disabled = makeService({ communication: [['c1'], []] });
    const r2 = await disabled.service.backfill({
      entityTypes: ['communication'],
      batchSize: 10,
      pendingThreshold: 0, // guard off: no depth probe, straight to the sweep
    });
    expect(r2.enqueued).toBe(1);
  });

  it('a failure on the FIRST page of a type reports zero enqueued for it without throwing', async () => {
    const { service, sendMany } = makeService({
      communication: [['c1'], []],
    });
    sendMany.mockRejectedValueOnce(new Error('boom'));

    const result = await service.backfill({ entityTypes: ['communication'], batchSize: 10 });

    expect(result.perType.communication).toBe(0);
    expect(result.errors).toEqual({ communication: 'boom' });
  });
});
