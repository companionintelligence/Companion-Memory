import { ConflictException } from '@nestjs/common';

import { EventEntity } from '@ci/domains/memory';
import { GeocodeBatchRequestEvent } from '@ci/domains/memory/events';
import { IndexSkipEntity } from '@ci/domains/search-ingress';

import { MaintenanceOrchestratorService, ORCHESTRATE_STAGES } from './MaintenanceOrchestratorService';

const USER_ID = 'user-1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the orchestrator with every leg dependency mocked. Each leg mock
 * records its stage name in the shared `callOrder` so ordering can be
 * asserted; the enqueue legs get a chainable EventEntity query builder
 * (`getCount`), the drain poll a chainable EmbeddingEntity builder
 * (`getRawOne`), and media_dimensions the raw `dataSource.query`.
 */
function makeService() {
  const callOrder: string[] = [];

  // Chainable count builder for the geocode / reverse_geocode candidate counts.
  const eventCountQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getCount: jest.fn(async () => 0),
  };

  // Chainable COUNT(*) builder for the search_index drain's embedded tally.
  const embeddingCountQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(async () => ({ count: '0' })),
  };

  // Chainable COUNT(*) builder for the drain's skip-marker tally.
  const skipCountQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(async () => ({ count: '0' })),
  };

  const dataSource = {
    getRepository: jest.fn((entity: unknown) => ({
      createQueryBuilder: jest.fn(() =>
        entity === EventEntity ? eventCountQb : entity === IndexSkipEntity ? skipCountQb : embeddingCountQb,
      ),
    })),
    // media_dimensions candidate count.
    query: jest.fn(async () => [{ count: '0' }]),
  };

  const send = jest.fn(async () => ['job-1']);
  const events = { send };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const personStub = {
    backfill: jest.fn(async () => {
      callOrder.push('extract_people');

      return { examined: 0, peopleCreated: 0 };
    }),
  };
  const commLink = {
    // Params kept so mockImplementationOnce overrides below can type their (userId, options) impls.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    backfill: jest.fn(async (_userId: string, _options?: unknown) => {
      callOrder.push('link_communications');

      return { examined: 0, fromLinked: 0, toLinked: 0, windows: 0, range: null };
    }),
  };
  const eventPart = {
    backfill: jest.fn(async () => {
      callOrder.push('link_events');

      return { examined: 0, organizersLinked: 0, participantsLinked: 0, pages: 0 };
    }),
  };
  const graphEnrich = {
    // Params kept so the mockImplementationOnce override below can type its (userId, options) impl.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    enrich: jest.fn(async (_userId: string, _options?: unknown) => {
      callOrder.push('extract_graph');

      return { sampledRecords: 0, errors: [] };
    }),
  };
  const locationEstimate = {
    countCandidates: jest.fn(async () => {
      callOrder.push('estimate_locations');

      return 0;
    }),
  };
  const searchIndex = {
    backfill: jest.fn(async () => {
      callOrder.push('search_index');

      return { enqueued: 0, perType: {} as Record<string, number> };
    }),
  };

  const service = new MaintenanceOrchestratorService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    personStub as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commLink as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventPart as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphEnrich as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    locationEstimate as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    searchIndex as any,
  );

  // Kill the progress throttle by default so forwarding tests see every line;
  // the throttle itself is exercised explicitly with the real default.
  service.progressMinIntervalMs = 0;

  return {
    service,
    callOrder,
    dataSource,
    eventCountQb,
    embeddingCountQb,
    skipCountQb,
    send,
    personStub,
    commLink,
    eventPart,
    graphEnrich,
    locationEstimate,
    searchIndex,
  };
}

type Line = Record<string, unknown>;

function collectEmits() {
  const lines: Line[] = [];
  const emit = (line: Line) => lines.push(line);

  return { lines, emit };
}

describe('MaintenanceOrchestratorService', () => {
  it('executes the requested stages in CANONICAL order, ignoring the body order', async () => {
    const { service, callOrder } = makeService();
    const { lines, emit } = collectEmits();

    // Deliberately scrambled: the in-process legs only, so callOrder is exact.
    const summary = await service.orchestrate(
      USER_ID,
      {
        stages: ['search_index', 'link_events', 'extract_people', 'extract_graph', 'link_communications'],
      },
      emit,
    );

    expect(callOrder).toEqual([
      'extract_people',
      'link_communications',
      'link_events',
      'extract_graph',
      'search_index',
    ]);
    expect(lines.filter((l) => l.type === 'leg-start').map((l) => l.leg)).toEqual([
      'extract_people',
      'link_communications',
      'link_events',
      'extract_graph',
      'search_index',
    ]);
    expect(summary.legs.map((l) => l.leg)).toEqual([
      'extract_people',
      'link_communications',
      'link_events',
      'extract_graph',
      'search_index',
    ]);
    expect(summary.ok).toBe(true);
  });

  it('defaults to ALL stages, numbering leg-start index/of over the full canonical set', async () => {
    const { service } = makeService();
    const { lines, emit } = collectEmits();

    const summary = await service.orchestrate(USER_ID, {}, emit);

    const starts = lines.filter((l) => l.type === 'leg-start');
    expect(starts.map((l) => l.leg)).toEqual([...ORCHESTRATE_STAGES]);
    expect(starts.map((l) => l.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(starts.every((l) => l.of === ORCHESTRATE_STAGES.length)).toBe(true);
    expect(summary.legs).toHaveLength(ORCHESTRATE_STAGES.length);
    expect(summary.ok).toBe(true);
  });

  it('fail-soft (default): a leg error emits leg-error, the chain continues, done.legs carries per-leg statuses', async () => {
    const { service, personStub, commLink, eventPart } = makeService();
    const { lines, emit } = collectEmits();
    personStub.backfill.mockRejectedValueOnce(new Error('identifier index unavailable'));

    const summary = await service.orchestrate(
      USER_ID,
      { stages: ['extract_people', 'link_communications', 'link_events'] },
      emit,
    );

    // The error is captured, not thrown; the remaining legs still ran.
    expect(commLink.backfill).toHaveBeenCalledTimes(1);
    expect(eventPart.backfill).toHaveBeenCalledTimes(1);

    const legError = lines.find((l) => l.type === 'leg-error');
    expect(legError).toMatchObject({
      leg: 'extract_people',
      ok: false,
      error: 'identifier index unavailable',
    });

    const done = lines.find((l) => l.type === 'done');
    expect(done).toMatchObject({
      ok: false,
      legs: { extract_people: 'error', link_communications: 'ok', link_events: 'ok' },
    });

    expect(summary.ok).toBe(false);
    expect(summary.legs).toMatchObject([
      { leg: 'extract_people', ok: false, error: 'identifier index unavailable' },
      { leg: 'link_communications', ok: true },
      { leg: 'link_events', ok: true },
    ]);
  });

  it('abortOnError: stops the chain at the failing leg and reports the remainder as skipped', async () => {
    const { service, personStub, commLink, eventPart } = makeService();
    const { lines, emit } = collectEmits();
    personStub.backfill.mockRejectedValueOnce(new Error('boom'));

    const summary = await service.orchestrate(
      USER_ID,
      { stages: ['extract_people', 'link_communications', 'link_events'], abortOnError: true },
      emit,
    );

    // Nothing after the failing leg ran.
    expect(commLink.backfill).not.toHaveBeenCalled();
    expect(eventPart.backfill).not.toHaveBeenCalled();

    const done = lines.find((l) => l.type === 'done');
    expect(done).toMatchObject({
      ok: false,
      legs: { extract_people: 'error', link_communications: 'skipped', link_events: 'skipped' },
    });

    expect(summary.legs).toMatchObject([
      { leg: 'extract_people', ok: false, error: 'boom' },
      { leg: 'link_communications', ok: false, error: 'skipped', durationMs: 0 },
      { leg: 'link_events', ok: false, error: 'skipped', durationMs: 0 },
    ]);
  });

  it('forwards a streaming leg’s own progress emits as leg-progress lines', async () => {
    const { service, commLink, graphEnrich } = makeService();
    const { lines, emit } = collectEmits();
    commLink.backfill.mockImplementationOnce(async (_userId: string, options: unknown) => {
      const opts = options as { onProgress?: (partial: object) => void };
      opts.onProgress?.({ examined: 5, fromLinked: 2, toLinked: 1, windows: 1 });
      opts.onProgress?.({ examined: 9, fromLinked: 4, toLinked: 2, windows: 2 });

      return { examined: 9, fromLinked: 4, toLinked: 2, windows: 2, range: null };
    });
    graphEnrich.enrich.mockImplementationOnce(async (_userId: string, options: unknown) => {
      const opts = options as {
        onProgress?: (done: number, total: number, partial: object) => void;
      };
      opts.onProgress?.(1, 4, { preferencesExtracted: 3 });

      return { sampledRecords: 10, errors: [] };
    });

    await service.orchestrate(USER_ID, { stages: ['link_communications', 'extract_graph'] }, emit);

    const progress = lines.filter((l) => l.type === 'leg-progress');
    expect(progress).toEqual([
      {
        type: 'leg-progress',
        leg: 'link_communications',
        examined: 5,
        fromLinked: 2,
        toLinked: 1,
        windows: 1,
      },
      {
        type: 'leg-progress',
        leg: 'link_communications',
        examined: 9,
        fromLinked: 4,
        toLinked: 2,
        windows: 2,
      },
      { type: 'leg-progress', leg: 'extract_graph', chunksDone: 1, chunksTotal: 4, preferencesExtracted: 3 },
    ]);
  });

  it('throttles forwarded leg-progress to at most one line per progressMinIntervalMs', async () => {
    const { service, commLink } = makeService();
    const { lines, emit } = collectEmits();
    service.progressMinIntervalMs = 60_000; // burst-proof: only the first frame passes
    commLink.backfill.mockImplementationOnce(async (_userId: string, options: unknown) => {
      const opts = options as { onProgress?: (partial: object) => void };
      for (let i = 1; i <= 10; i += 1) {
        opts.onProgress?.({ examined: i });
      }

      return { examined: 10, fromLinked: 0, toLinked: 0, windows: 1, range: null };
    });

    await service.orchestrate(USER_ID, { stages: ['link_communications'] }, emit);

    const progress = lines.filter((l) => l.type === 'leg-progress');
    expect(progress).toEqual([{ type: 'leg-progress', leg: 'link_communications', examined: 1 }]);
  });

  it('forwards per-leg options to the leg service (with onProgress injected on the streaming legs)', async () => {
    const { service, personStub, commLink, searchIndex } = makeService();

    await service.orchestrate(USER_ID, {
      stages: ['extract_people', 'link_communications', 'search_index'],
      options: {
        extractPeople: { windowDays: 14 },
        linkCommunications: { windowDays: 3, windowLimit: 100 },
        searchIndex: { batchSize: 500, entityTypes: ['communication'] },
      },
    });

    expect(personStub.backfill).toHaveBeenCalledWith(USER_ID, { windowDays: 14 });
    expect(commLink.backfill).toHaveBeenCalledWith(USER_ID, {
      windowDays: 3,
      windowLimit: 100,
      onProgress: expect.any(Function),
    });
    expect(searchIndex.backfill).toHaveBeenCalledWith({ batchSize: 500, entityTypes: ['communication'] });
  });

  it('geocode legs are enqueue-and-return: candidate count capped at limit, one job on the geocode queue', async () => {
    const { service, eventCountQb, send } = makeService();
    eventCountQb.getCount.mockResolvedValue(250);

    const summary = await service.orchestrate(USER_ID, {
      stages: ['geocode', 'reverse_geocode'],
      options: { geocode: { limit: 100 }, reverseGeocode: { limit: 40, retryNull: true } },
    });

    expect(send).toHaveBeenCalledWith(
      GeocodeBatchRequestEvent,
      { userId: USER_ID, limit: 100, retryNull: false },
      { queue: 'geocode' },
    );
    expect(send).toHaveBeenCalledWith(
      GeocodeBatchRequestEvent,
      { userId: USER_ID, limit: 40, retryNull: true, direction: 'reverse' },
      { queue: 'geocode' },
    );
    expect(summary.legs).toMatchObject([
      { leg: 'geocode', ok: true, result: { jobId: 'job-1', estimatedEventCount: 100, status: 'enqueued' } },
      {
        leg: 'reverse_geocode',
        ok: true,
        result: { jobId: 'job-1', estimatedEventCount: 40, status: 'enqueued' },
      },
    ]);
  });

  it('enqueue legs noop (no job sent) when the candidate count is zero', async () => {
    const { service, send } = makeService();

    const summary = await service.orchestrate(USER_ID, {
      stages: ['geocode', 'estimate_locations', 'media_dimensions'],
    });

    expect(send).not.toHaveBeenCalled();
    for (const leg of summary.legs) {
      expect(leg.ok).toBe(true);
      expect(leg.result).toMatchObject({ jobId: null, status: 'noop' });
    }
  });

  it('search_index drain: polls the embedded count (delta vs baseline) until enqueued is reached, emitting leg-progress', async () => {
    const { service, searchIndex, embeddingCountQb } = makeService();
    const { lines, emit } = collectEmits();
    service.drainPollIntervalMs = 1;
    searchIndex.backfill.mockResolvedValueOnce({ enqueued: 3, perType: { communication: 3 } });
    // Baseline read (pre-sweep) = 10; polls then observe 11, then 13 → deltas 1, 3.
    embeddingCountQb.getRawOne
      .mockResolvedValueOnce({ count: '10' })
      .mockResolvedValueOnce({ count: '11' })
      .mockResolvedValueOnce({ count: '13' });

    const summary = await service.orchestrate(
      USER_ID,
      {
        stages: ['search_index'],
        options: { searchIndex: { entityTypes: ['communication'] } },
        searchIndexDrain: {},
      },
      emit,
    );

    // The poll stops as soon as embedded >= enqueued: exactly two polls (3 reads with baseline).
    expect(embeddingCountQb.getRawOne).toHaveBeenCalledTimes(3);
    // The drain count is restricted to the swept entity types.
    expect(embeddingCountQb.where).toHaveBeenCalledWith('embedding.entityType IN (:...types)', {
      types: ['communication'],
    });

    const progress = lines.filter((l) => l.type === 'leg-progress');
    expect(progress).toEqual([
      { type: 'leg-progress', leg: 'search_index', enqueued: 3, embedded: 1, skipped: 0 },
      { type: 'leg-progress', leg: 'search_index', enqueued: 3, embedded: 3, skipped: 0 },
    ]);

    expect(summary.legs[0].result).toMatchObject({
      enqueued: 3,
      drain: { enqueued: 3, embedded: 3, skipped: 0, drained: true },
    });
  });

  it('search_index drain: counts skip-marked rows toward completion, so a skip-heavy drain ends without the timeout', async () => {
    const { service, searchIndex, embeddingCountQb, skipCountQb } = makeService();
    const { lines, emit } = collectEmits();
    service.drainPollIntervalMs = 1;
    // 5 enqueued; the listeners embed 2 and DECLINE 3 (index_skips). An
    // embedded-only poll would sit at 2 < 5 until the timeout — the 13k-row
    // Discord sync that idled its full 10-minute budget on every run.
    searchIndex.backfill.mockResolvedValueOnce({ enqueued: 5, perType: { communication: 5 } });
    embeddingCountQb.getRawOne
      .mockResolvedValueOnce({ count: '10' }) // baseline
      .mockResolvedValueOnce({ count: '12' }); // poll: delta 2
    skipCountQb.getRawOne
      .mockResolvedValueOnce({ count: '3' }) // baseline
      .mockResolvedValueOnce({ count: '6' }); // poll: delta 3

    const summary = await service.orchestrate(
      USER_ID,
      { stages: ['search_index'], searchIndexDrain: { timeoutMs: 60_000 } },
      emit,
    );

    // One poll sufficed: 2 embedded + 3 skipped covers the 5 enqueued.
    expect(embeddingCountQb.getRawOne).toHaveBeenCalledTimes(2);
    expect(skipCountQb.getRawOne).toHaveBeenCalledTimes(2);
    expect(lines.filter((l) => l.type === 'leg-progress')).toEqual([
      { type: 'leg-progress', leg: 'search_index', enqueued: 5, embedded: 2, skipped: 3 },
    ]);
    expect(summary.legs[0].result).toMatchObject({
      drain: { enqueued: 5, embedded: 2, skipped: 3, drained: true },
    });
  });

  it('search_index drain: gives up at timeoutMs when the queue is genuinely stalled (nothing embeds or skips)', async () => {
    const { service, searchIndex, embeddingCountQb } = makeService();
    const { emit } = collectEmits();
    service.drainPollIntervalMs = 1;
    searchIndex.backfill.mockResolvedValueOnce({ enqueued: 5, perType: { communication: 5 } });
    embeddingCountQb.getRawOne.mockResolvedValue({ count: '10' }); // flat: embedded delta stays 0
    // skipCountQb stays at its default flat 0 → skipped delta stays 0 too.

    const summary = await service.orchestrate(
      USER_ID,
      { stages: ['search_index'], searchIndexDrain: { timeoutMs: 20 } },
      emit,
    );

    expect(summary.legs[0].ok).toBe(true);
    expect(summary.legs[0].result).toMatchObject({
      drain: { enqueued: 5, embedded: 0, skipped: 0, drained: false },
    });
  });

  it('skips the drain poll entirely when searchIndexDrain is absent', async () => {
    const { service, searchIndex, embeddingCountQb } = makeService();

    const summary = await service.orchestrate(USER_ID, { stages: ['search_index'] });

    expect(searchIndex.backfill).toHaveBeenCalledTimes(1);
    expect(embeddingCountQb.getRawOne).not.toHaveBeenCalled();
    expect(summary.legs[0].result).toEqual({ enqueued: 0, perType: {} });
  });

  it('emits ~10s tick heartbeats while a leg runs (single interval, stream only)', async () => {
    const { service, personStub } = makeService();
    const { lines, emit } = collectEmits();
    service.tickIntervalMs = 5;
    personStub.backfill.mockImplementationOnce(async () => {
      await sleep(30);

      return { examined: 0, peopleCreated: 0 };
    });

    await service.orchestrate(USER_ID, { stages: ['extract_people'] }, emit);

    const ticks = lines.filter((l) => l.type === 'tick');
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    for (const tick of ticks) {
      expect(typeof tick.at).toBe('string');
      expect(Number.isNaN(Date.parse(tick.at as string))).toBe(false);
    }
  });

  it('409s a second orchestrate for the SAME user while one is running, and releases the lock in finally', async () => {
    const { service, personStub } = makeService();

    let release!: () => void;
    personStub.backfill.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ examined: 0, peopleCreated: 0 });
        }),
    );

    const first = service.orchestrate(USER_ID, { stages: ['extract_people'] });
    expect(service.isRunning(USER_ID)).toBe(true);

    // Second call for the same user: immediate 409, no partial run.
    await expect(service.orchestrate(USER_ID, { stages: ['extract_people'] })).rejects.toThrow(
      ConflictException,
    );

    // A DIFFERENT user is not blocked by the lock.
    await expect(service.orchestrate('user-2', { stages: ['link_events'] })).resolves.toMatchObject({
      ok: true,
    });

    release();
    await expect(first).resolves.toMatchObject({ ok: true });

    // Lock released: the same user can orchestrate again.
    expect(service.isRunning(USER_ID)).toBe(false);
    await expect(service.orchestrate(USER_ID, { stages: ['extract_people'] })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('releases the lock even when the run itself throws past the fail-soft net', async () => {
    const { service } = makeService();

    // Force a failure OUTSIDE the per-leg try/catch: an emit callback that throws.
    const badEmit = () => {
      throw new Error('socket gone');
    };

    await expect(service.orchestrate(USER_ID, { stages: ['extract_people'] }, badEmit)).rejects.toThrow(
      'socket gone',
    );

    expect(service.isRunning(USER_ID)).toBe(false);
  });
});
