import { BrowserActivityCreatedEvent } from '@ci/domains/browser-activity/events';
import { ThreadCreatedEvent } from '@ci/domains/conversations/events';
import { FileCreatedEvent } from '@ci/domains/files/events';
import {
  CommunicationCreatedEvent,
  ConceptCreatedEvent,
  ContentCreatedEvent,
  EventCreatedEvent,
  ItemCreatedEvent,
  PersonCreatedEvent,
  PlaceCreatedEvent,
} from '@ci/domains/memory/events';
import { NoteCreatedEvent } from '@ci/domains/notes/events';
import { STAGE_ID_LIST } from '@ci/domains/pipeline';
import { TaskCreatedEvent } from '@ci/domains/planning/events';

import {
  BACKFILLABLE_ENTITIES,
  PIPELINE_COVERED_STAGES,
  SearchIndexBackfillService,
  normalizeBackfillEntityTypes,
} from './SearchIndexBackfillService';

const SEARCH_INDEX_QUEUE = 'search-index';

describe('normalizeBackfillEntityTypes', () => {
  // Regression guard for the reverted Wave D fold
  // (20260812144811_revert_browser_activity_event_fold): this used to widen a
  // browser-activity scope to event + content for the dual-written mirrors. The
  // dual-write is gone, so widening would silently sweep the whole events and
  // content corpora for a caller who asked only for browsing rows.
  it('does not widen a browser-activity scope to event or content', () => {
    expect(normalizeBackfillEntityTypes(['browser-activity'])).toEqual(['browser-activity']);
  });

  it('leaves an already-canonical scope alone', () => {
    expect(normalizeBackfillEntityTypes(['communication', 'event'])).toEqual(['communication', 'event']);
  });

  it('dedupes and orders by BACKFILLABLE_ENTITIES, whatever order the caller used', () => {
    expect(normalizeBackfillEntityTypes(['item', 'browser-activity', 'event', 'item'])).toEqual([
      'event',
      'item',
      'browser-activity',
    ]);
  });
});

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

describe('PIPELINE_COVERED_STAGES', () => {
  // The map's stage ids are string literals (importing the pipeline domain from
  // the service would be a module cycle — pipeline already imports maintenance).
  // This spec is the sync pin the map's doc comment promises: an entry naming a
  // stage that no longer exists, or an entity type the sweep doesn't know,
  // fails here instead of silently changing what the sweep selects.
  it('maps known backfillable entity types to declared pipeline stage ids', () => {
    for (const [entityType, stage] of Object.entries(PIPELINE_COVERED_STAGES)) {
      expect(BACKFILLABLE_ENTITIES).toContain(entityType);
      expect(STAGE_ID_LIST).toContain(stage);
    }
  });

  it('covers content via index.embed (the pipeline stage that embeds ci.content)', () => {
    expect(PIPELINE_COVERED_STAGES.content).toBe('index.embed');
  });

  it('covers every backfillable type except the declared exceptions', () => {
    // `position` arrived with the GPS→places indexing and has no pipeline
    // stage yet — the old backfill path still owns it. `product` and `receipt`
    // arrived the same way with the object tables: their listeners exist, their
    // pipeline `index.embed_*` stages do not. `concept` has no pipeline stage AT
    // ALL (no INDEX_EMBED_CONCEPT in STAGE_IDS) — building one is the deliberate,
    // larger follow-up; omitting it here just means the sweep does not
    // double-check against ci.pipeline_state for concept, the same safe fallback
    // `missingIds` already uses for the others. Anything ELSE missing from the
    // map is a regression: the pipeline is the indexing path.
    // `note`, `thread`, `task` and `place` are indexed live by their listeners
    // and have no pipeline stage; their lanes exist only to give rows written
    // before ci_search.mobile_search_documents a device document.
    const uncovered = ['position', 'product', 'receipt', 'concept', 'note', 'thread', 'task', 'place'];

    expect(Object.keys(PIPELINE_COVERED_STAGES).sort()).toEqual(
      BACKFILLABLE_ENTITIES.filter((type) => !uncovered.includes(type)).sort(),
    );
  });
});

describe('SearchIndexBackfillService', () => {
  it('bulk re-emits each type’s create events onto the search-index queue ONLY, with correct counts', async () => {
    const { service, sendMany } = makeService({
      communication: [['c1', 'c2'], []],
      event: [['e1'], []],
      content: [[], []],
      item: [['i1', 'i2', 'i3'], []],
      'browser-activity': [['b1'], []],
      file: [['f1', 'f2'], []],
      person: [['p1'], []],
      concept: [['k1'], []],
    });

    const result = await service.backfill({ batchSize: 100 });

    expect(result).toEqual({
      enqueued: 11,
      perType: {
        communication: 2,
        event: 1,
        content: 0,
        item: 3,
        'browser-activity': 1,
        file: 2,
        person: 1,
        concept: 1,
        position: 0,
        product: 0,
        receipt: 0,
        note: 0,
        thread: 0,
        task: 0,
        place: 0,
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
        person: 0,
        concept: 0,
        position: 0,
        product: 0,
        receipt: 0,
        note: 0,
        thread: 0,
        task: 0,
        place: 0,
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
    // person rows (extract_people stubs, created without a per-row event) ride
    // the same bulk path so people extracted from communications become searchable.
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: PersonCreatedEvent, data: { personId: 'p1' } },
    ]);
    // concept rows (GraphIngestService bulk upserts, same no-per-row-event path
    // as person) ride the same bulk path — this is the regression #2175's
    // review caught: 0 of N imported concepts were ever searchable before this.
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: ConceptCreatedEvent, data: { conceptId: 'k1' } },
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

  it('keeps a browser-activity-only scope scoped: no event or content sweep', async () => {
    // The Wave D dual-write into ci.events + ci.content was reverted
    // (20260812144811), so this scope must stay exactly what was asked for —
    // widening it would reindex the entire events and content corpora.
    const { service, sendMany } = makeService({
      'browser-activity': [['b1'], []],
      event: [['should-not-run'], []],
      content: [['should-not-run'], []],
      communication: [['should-not-run'], []],
    });

    const result = await service.backfill({
      entityTypes: ['browser-activity'],
      batchSize: 100,
    });

    expect(result.perType).toEqual({ 'browser-activity': 1 });
    expect(result.enqueued).toBe(1);
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: BrowserActivityCreatedEvent, data: { browserActivityId: 'b1' } },
    ]);

    const otherTypesEmitted = sendMany.mock.calls.some((call) =>
      ((call as unknown[])[1] as Array<{ name: string }>).some((e) =>
        [EventCreatedEvent, ContentCreatedEvent, CommunicationCreatedEvent].includes(e.name),
      ),
    );
    expect(otherTypesEmitted).toBe(false);
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

  it('anti-joins ci.pipeline_state with each type’s covering stage, so the sweep never redoes pipeline work', async () => {
    const { service, ds } = makeService({
      content: [['c1'], []], // plain uuid-keyset branch
      communication: [['m1'], []], // time-paged (hypertable) branch
    });

    await service.backfill({ entityTypes: ['content', 'communication'], batchSize: 10 });

    let pageQueries = 0;
    for (const [sql, params] of ds.query.mock.calls) {
      const flat = (sql as string).replace(/\s+/g, ' ');
      if (!params || /FROM ci_search\.embeddings/i.test(flat)) {
        continue; // depth / drain-count probes, not page queries
      }

      pageQueries += 1;
      const stage = params[0] === 'content' ? 'index.embed' : 'index.embed_communication';
      expect(flat).toContain('LEFT JOIN ci.pipeline_state ps');
      expect(flat).toContain(`ps.stage = '${stage}'`);
      expect(flat).toContain('ps.entity_id IS NULL');
    }

    expect(pageQueries).toBeGreaterThan(0);
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

  it('re-emits note, thread and place by id, and task with its owner (the task listener scopes its read by it)', async () => {
    const { service, sendMany, ds } = makeService({
      note: [['n1'], []],
      thread: [['t1'], []],
      place: [['l1'], []],
      task: [['k1'], []],
    });
    // The sweep selects the owner column for task; the shared mock returns ids only.
    const defaultQuery = ds.query.getMockImplementation()!;

    ds.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const rows = (await defaultQuery(sql, params)) as Array<{ id: string }>;

      return params?.[0] === 'task' && /AS owner/.test(sql)
        ? rows.map((row) => ({ ...row, owner: 'u1' }))
        : rows;
    });

    await service.backfill({ entityTypes: ['note', 'thread', 'task', 'place'], batchSize: 10 });

    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: NoteCreatedEvent, data: { noteId: 'n1' } },
    ]);
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: ThreadCreatedEvent, data: { threadId: 't1' } },
    ]);
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: PlaceCreatedEvent, data: { placeId: 'l1' } },
    ]);
    expect(sendMany).toHaveBeenCalledWith(SEARCH_INDEX_QUEUE, [
      { name: TaskCreatedEvent, data: { taskId: 'k1', userId: 'u1' } },
    ]);
    // Only the task lane selects an owner column (on every page it reads).
    const ownerSelects = ds.query.mock.calls.filter(([sql]) => /AS owner/.test(sql as string));
    expect(new Set(ownerSelects.map(([, params]) => (params as unknown[])[0]))).toEqual(new Set(['task']));
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
