import { BACKFILL_JOB_PRIORITY, DEFAULT_JOB_PRIORITY, INTERACTIVE_JOB_PRIORITY } from '@ci/domains/events';

import {
  DEFAULT_SLICE_SIZE,
  MAX_SLICES_PER_SWEEP,
  MAX_SWEEP_HOPS,
  PIPELINE_QUEUES,
  PIPELINE_QUEUE_NAMES,
} from '../../constants';
import { PipelineSliceEvent, PipelineSweepEvent } from '../../events';
import { pipelineSlicePayloadSchema, pipelineSweepPayloadSchema } from '../../types';
import { PipelineDispatchService } from '../PipelineDispatchService';

/**
 * The dispatcher: the only thing in the pipeline that decides WHAT gets queued.
 *
 * It has exactly one job — turn "this stage has stale rows" into pg-boss jobs —
 * and four ways to get that catastrophically wrong, each of which is a defect
 * this rebuild exists to delete:
 *
 *  1. **Paging.** The nine hand-written maintenance legs it replaces had nine
 *     pagination strategies. A keyset cursor that is off by one either DROPS the
 *     last id of every page (silent loss that looks like completion) or REPEATS
 *     it (a sweep that never terminates). Neither is visible from a log line, so
 *     the sweep is driven here over a corpus larger than one hop and the ids it
 *     handed out are compared against the corpus, exactly.
 *  2. **Termination.** The sweep re-enqueues ITSELF. A chain that requeues one
 *     hop past dry burns a worker slot forever; one that stops early abandons
 *     the tail of the corpus with no error anywhere.
 *  3. **Ordering.** The next hop must land BEHIND the slices it just produced,
 *     on the same queue at the same priority. That ordering IS the pipeline's
 *     backpressure — there is no token bucket and no queue-depth poll. If the
 *     hop overtakes its own slices the sweep runs away and enqueues the whole
 *     corpus in a few seconds, burying every other queue's traffic.
 *  4. **Bounds.** One slice is one pg-boss job and one unit of resumability. A
 *     slice that grows with the corpus re-creates the unresumable 200-row batch
 *     the pipeline was built to remove.
 *
 * No Postgres and no queue. `PipelineStateService` is replaced by a source that
 * implements THE ONE RULE's keyset semantics faithfully (`ORDER BY id`, `id >
 * cursor`, `LIMIT n`) over an in-memory corpus, so a cursor bug in the
 * dispatcher shows up as a missing or duplicated id rather than as agreement
 * with a mock that returns whatever it is asked for. `EventService` records
 * every enqueue in call order, which is what makes assertion 3 possible at all.
 */

const USER = '00000000-0000-4000-8000-00000000aaaa';
const OTHER_USER = '00000000-0000-4000-8000-00000000bbbb';
const ENTITY_TYPE = 'file';
const STAGE_ID = 'enrich.media_dimensions';

/**
 * Ids that sort identically as uuids (Postgres orders them byte-wise) and as JS
 * strings, so the in-memory source can page with `>` exactly as the SQL does and
 * the dispatcher's own cursor-advance assertion sees the same ordering.
 */
function srcId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** `[srcId(1) … srcId(n)]` — a source table, in key order. */
function corpusOf(n: number): string[] {
  return Array.from({ length: n }, (_, i) => srcId(i + 1));
}

interface StageLike {
  id: string;
  version: number;
  queue: string;
  entityTypes: readonly string[];
  source: {
    schema: string;
    table: string;
    idColumn: string;
    userColumn: string;
    predicate?: string;
  };
  run: unknown;
}

function makeStage(overrides: Partial<StageLike> = {}): StageLike {
  return {
    id: STAGE_ID,
    version: 3,
    queue: PIPELINE_QUEUES.ENRICH,
    entityTypes: [ENTITY_TYPE],
    source: {
      schema: 'ci',
      table: 'files',
      idColumn: 'id',
      userColumn: 'user_id',
      predicate: "s.content_type LIKE 'image/%'",
    },
    run: jest.fn(async () => new Map()),
    ...overrides,
  };
}

/** One observed enqueue. `send` and `sendMany` are normalised to one shape. */
interface Enqueue {
  via: 'send' | 'sendMany';
  queue: string | undefined;
  priority: number | undefined;
  jobs: Array<{ name: string; data: Record<string, unknown> }>;
}

/** One recorded candidate query, as the dispatcher asked for it. */
interface Select {
  stageId: string;
  userId: string;
  cursor: string | null;
  limit: number;
  entityType: string | undefined;
}

interface HarnessOptions {
  /** Rows the source holds for {@link USER}, in key order. */
  corpus?: string[];
  stage?: Partial<StageLike>;
  /** Replaces the keyset source entirely, for pathological cases. */
  stale?: (cursor: string | null, limit: number) => string[];
  /** Resolve the stage id to nothing, as an unregistered stage would. */
  unknownStage?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const stage = makeStage(options.stage);
  const corpus = options.corpus ?? corpusOf(0);

  const selects: Select[] = [];
  const enqueued: Enqueue[] = [];

  const stateService = {
    setContext: jest.fn(),
    // THE ONE RULE's keyset half, honestly implemented: strictly greater than
    // the cursor, ordered by id, capped at the limit. A dispatcher that hands
    // back the wrong cursor therefore skips or repeats real ids here, instead of
    // being agreed with.
    selectStale: jest.fn(
      async (
        s: StageLike,
        userId: string,
        cursor: string | null,
        limit: number,
        entityType?: string,
      ): Promise<string[]> => {
        selects.push({ stageId: s.id, userId, cursor: cursor ?? null, limit, entityType });

        if (!Number.isInteger(limit) || limit < 1) {
          throw new Error(`selectStale limit must be a positive integer, got ${String(limit)}`);
        }

        if (options.stale !== undefined) {
          return options.stale(cursor ?? null, limit);
        }

        // The sweep is always user-scoped; another user's rows are not this
        // sweep's candidates.
        if (userId !== USER) {
          return [];
        }

        const remaining = cursor == null ? corpus : corpus.filter((id) => id > cursor);

        return remaining.slice(0, limit);
      },
    ),
    claim: jest.fn(async () => [] as string[]),
    complete: jest.fn(async () => ({ done: 0, skipped: 0, failed: 0, quarantined: 0 })),
    fail: jest.fn(async () => ({ done: 0, skipped: 0, failed: 0, quarantined: 0 })),
    coverage: jest.fn(async () => ({ done: 0, skipped: 0, failed: 0, pending: 0 })),
  };

  const stageRegistry = {
    setContext: jest.fn(),
    // The real registry THROWS rather than returning null, so a bad stage id
    // fails at the call site instead of inside a worker three minutes later.
    get: jest.fn((stageId: string) => {
      if (options.unknownStage === true) {
        throw new Error(`Unknown pipeline stage "${stageId}".`);
      }

      return stage;
    }),
    has: jest.fn(() => options.unknownStage !== true),
    stageIds: jest.fn(() => (options.unknownStage === true ? [] : [STAGE_ID])),
  };

  const eventService = {
    setContext: jest.fn(),
    send: jest.fn(
      async (name: string, data: Record<string, unknown>, opts?: { queue?: string; priority?: number }) => {
        enqueued.push({
          via: 'send',
          queue: opts?.queue,
          priority: opts?.priority,
          jobs: [{ name, data }],
        });

        return ['job-1'];
      },
    ),
    sendMany: jest.fn(
      async (
        queue: string,
        jobs: Array<{ name: string; data: Record<string, unknown> }>,
        opts?: { priority?: number },
      ) => {
        enqueued.push({ via: 'sendMany', queue, priority: opts?.priority, jobs });
      },
    ),
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const service = new PipelineDispatchService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stateService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stageRegistry as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  // Re-asserted by name so a future reordering of the constructor's four
  // collaborators fails as a compile/wiring error rather than as a test that
  // quietly exercises the wrong double — two of them are structurally similar
  // bags of jest.fn.
  Object.assign(service, { stateService, stageRegistry, eventService, logger });

  function sweepPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      stage: STAGE_ID,
      userId: USER,
      cursor: null,
      sliceSize: 2,
      hop: 0,
      dispatched: 0,
      ...overrides,
    };
  }

  /**
   * Drive the whole self-requeuing chain, one hop at a time, exactly as a queue
   * would: run the hop, take whatever sweep job it enqueued for itself, run
   * that. Returns one entry per hop, each carrying the hop's result and the
   * enqueues it produced IN ORDER — which is what the backpressure assertions
   * read.
   */
  async function drain(overrides: Record<string, unknown> = {}) {
    const hops: Array<{ result: Awaited<ReturnType<typeof service.runSweepHop>>; log: Enqueue[] }> = [];

    let pending: Record<string, unknown> | null = sweepPayload(overrides);

    while (pending != null) {
      if (hops.length > 200) {
        throw new Error('sweep did not terminate within 200 hops');
      }

      const before = enqueued.length;
      const result = await service.runSweepHop(pending);
      const log = enqueued.slice(before);

      hops.push({ result, log });

      const requeues = log.flatMap((e) => e.jobs).filter((job) => job.name === PipelineSweepEvent);

      // A hop that requeued itself twice would double the chain on every hop —
      // an exponential enqueue, not a sweep.
      expect(requeues.length).toBeLessThanOrEqual(1);

      pending = requeues.length === 1 ? requeues[0].data : null;
    }

    return hops;
  }

  /** Every slice job enqueued so far, in enqueue order. */
  function sliceJobs(log: Enqueue[] = enqueued) {
    return log.flatMap((e) =>
      e.jobs.filter((job) => job.name === PipelineSliceEvent).map((job) => ({ enqueue: e, data: job.data })),
    );
  }

  /** Every id handed out, in the order it was handed out. */
  function dispatchedIds(log: Enqueue[] = enqueued): string[] {
    return sliceJobs(log).flatMap(({ data }) => data.ids as string[]);
  }

  return {
    service,
    stage,
    stateService,
    stageRegistry,
    eventService,
    logger,
    selects,
    enqueued,
    sweepPayload,
    drain,
    sliceJobs,
    dispatchedIds,
  };
}

describe('PipelineDispatchService.startSweep', () => {
  it('enqueues one sweep job on the stage own queue and nothing else', async () => {
    // startSweep returns as soon as the first hop is ENQUEUED. It must not page
    // the source itself: the whole point of the chain is that progress lives in
    // `pgboss.job`, not in the request that started it.
    const h = makeHarness({ corpus: corpusOf(10) });

    await h.service.startSweep({ stage: STAGE_ID, userId: USER });

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].jobs).toHaveLength(1);
    expect(h.enqueued[0].jobs[0].name).toBe(PipelineSweepEvent);
    expect(h.enqueued[0].queue).toBe(h.stage.queue);
    expect(h.stateService.selectStale).not.toHaveBeenCalled();
  });

  it('starts from a null cursor at hop zero', async () => {
    const h = makeHarness();

    await h.service.startSweep({ stage: STAGE_ID, userId: USER });

    expect(h.enqueued[0].jobs[0].data).toEqual(
      expect.objectContaining({ stage: STAGE_ID, userId: USER, cursor: null, hop: 0 }),
    );
  });

  it('defaults the slice size and honours an explicit one', async () => {
    const auto = makeHarness();
    await auto.service.startSweep({ stage: STAGE_ID, userId: USER });
    expect(auto.enqueued[0].jobs[0].data.sliceSize).toBe(DEFAULT_SLICE_SIZE);

    const explicit = makeHarness();
    await explicit.service.startSweep({ stage: STAGE_ID, userId: USER, sliceSize: 37 });
    expect(explicit.enqueued[0].jobs[0].data.sliceSize).toBe(37);
  });

  it('emits a payload the hop it will be handed to can actually parse', async () => {
    // The payload survives a round trip through `pgboss.job.data` as JSON and is
    // re-parsed on arrival. A start that emits something the worker rejects
    // dead-letters immediately and the sweep never begins.
    const h = makeHarness();

    await h.service.startSweep({ stage: STAGE_ID, userId: USER });

    const parsed = pipelineSweepPayloadSchema.safeParse(
      JSON.parse(JSON.stringify(h.enqueued[0].jobs[0].data)),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown stage at the call site, enqueuing nothing', async () => {
    // Resolved by the caller's thread — an HTTP request, a cron — so a typo is
    // an error someone sees, not a dead letter three minutes later.
    const h = makeHarness({ unknownStage: true });

    await expect(h.service.startSweep({ stage: 'enrich.no_such_stage', userId: USER })).rejects.toThrow();
    expect(h.enqueued).toHaveLength(0);
  });
});

describe('PipelineDispatchService keyset paging', () => {
  it('hands every id out exactly once, in key order', async () => {
    // 12 ids at 2 per slice is 6 slices — more than MAX_SLICES_PER_SWEEP, so the
    // corpus spans a hop boundary as well as page boundaries.
    const corpus = corpusOf(12);
    const h = makeHarness({ corpus });

    await h.drain({ sliceSize: 2 });

    const dispatched = h.dispatchedIds();
    expect(dispatched).toEqual(corpus);
    expect(new Set(dispatched).size).toBe(corpus.length);
  });

  it('never drops or repeats the id on a page boundary', async () => {
    // The classic off-by-one: the last id of page N is either skipped (cursor
    // advanced past it) or handed out again (cursor left one short). Both are
    // invisible in a log line, so the pages are checked against each other
    // directly — every page must begin immediately after the previous one ended.
    const corpus = corpusOf(13);
    const h = makeHarness({ corpus });

    await h.drain({ sliceSize: 3 });

    const pages = h.sliceJobs().map(({ data }) => data.ids as string[]);

    for (let i = 1; i < pages.length; i += 1) {
      const previous = pages[i - 1];
      const current = pages[i];
      const lastOfPrevious = previous[previous.length - 1];

      expect(current[0] > lastOfPrevious).toBe(true);
      // Contiguity: nothing in the corpus sits between the two.
      expect(corpus.indexOf(current[0])).toBe(corpus.indexOf(lastOfPrevious) + 1);
    }

    expect(pages.flat()).toEqual(corpus);
  });

  it('advances the cursor to the last id of the page it just dispatched', async () => {
    const corpus = corpusOf(9);
    const h = makeHarness({ corpus });

    await h.drain({ sliceSize: 3 });

    // The first query starts from nothing; each subsequent one resumes at the
    // end of the previous page — never at its start, never past its end.
    expect(h.selects[0].cursor).toBeNull();
    expect(h.selects.map((s) => s.cursor).slice(1)).toEqual([srcId(3), srcId(6), srcId(9)]);
  });

  it('resumes from the cursor it was handed rather than restarting', async () => {
    // This is what makes the sweep durable across an API restart: the cursor
    // lives in the job payload, so the next hop begins where the killed one
    // stopped instead of re-dispatching the corpus from the top.
    const h = makeHarness({ corpus: corpusOf(10) });

    await h.drain({ cursor: srcId(4), sliceSize: 3 });

    expect(h.dispatchedIds()).toEqual([srcId(5), srcId(6), srcId(7), srcId(8), srcId(9), srcId(10)]);
  });

  it('scopes every candidate query to the payload user and stage', async () => {
    const h = makeHarness({ corpus: corpusOf(6) });

    await h.drain({ userId: OTHER_USER, sliceSize: 2 });

    expect(h.selects.length).toBeGreaterThan(0);
    for (const select of h.selects) {
      expect(select.userId).toBe(OTHER_USER);
      expect(select.stageId).toBe(STAGE_ID);
    }
  });

  it('refuses to loop when the source stops advancing the cursor', async () => {
    // A source that answers with the same page forever would otherwise be an
    // infinite enqueue — the one bug class that fills `pgboss.job` faster than
    // any worker drains it. Nothing may be enqueued on the way out either: a
    // non-advancing sweep that still queued its slices would keep the duplicates.
    const page = [srcId(1), srcId(2)];
    const h = makeHarness({ stale: () => [...page] });

    await expect(h.service.runSweepHop(h.sweepPayload({ sliceSize: 2 }))).rejects.toThrow(/advance/i);
    expect(h.enqueued).toHaveLength(0);
  });

  it('stops at the hop ceiling instead of requeuing forever', async () => {
    const h = makeHarness({ corpus: corpusOf(100) });

    const result = await h.service.runSweepHop(h.sweepPayload({ hop: MAX_SWEEP_HOPS, sliceSize: 2 }));

    expect(result.dispatched).toBe(0);
    expect(h.enqueued).toHaveLength(0);
    expect(h.stateService.selectStale).not.toHaveBeenCalled();
    // Silence here would be worse than the runaway: a sweep that stopped
    // mid-corpus and said nothing looks exactly like a finished one.
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('rejects a payload that is not a sweep, without querying or enqueuing', async () => {
    // The payload came out of `pgboss.job.data`: JSON written by some earlier
    // release, possibly weeks ago. Parsed, never cast.
    const h = makeHarness({ corpus: corpusOf(4) });

    await expect(h.service.runSweepHop({ stage: STAGE_ID, userId: 'not-a-uuid' })).rejects.toThrow();
    expect(h.stateService.selectStale).not.toHaveBeenCalled();
    expect(h.enqueued).toHaveLength(0);
  });
});

describe('PipelineDispatchService self-requeue', () => {
  it('requeues itself while candidates remain and stops when the source runs dry', async () => {
    // 24 ids at 2 per slice with a ceiling of 5 slices per hop: 10, 10, then the
    // remaining 4 and a dry page. Only the last hop may leave the chain unqueued.
    const h = makeHarness({ corpus: corpusOf(24) });

    const hops = await h.drain({ sliceSize: 2 });

    expect(hops.length).toBeGreaterThan(1);

    hops.forEach(({ result }, index) => {
      const isLast = index === hops.length - 1;
      expect(result.exhausted).toBe(isLast);
    });

    const requeues = h.enqueued.flatMap((e) => e.jobs).filter((job) => job.name === PipelineSweepEvent);
    expect(requeues).toHaveLength(hops.length - 1);
  });

  it('carries the advanced cursor, the next hop number and the running total forward', async () => {
    const h = makeHarness({ corpus: corpusOf(24) });

    const hops = await h.drain({ sliceSize: 2 });

    const requeues = h.enqueued.flatMap((e) => e.jobs).filter((job) => job.name === PipelineSweepEvent);
    const first = requeues[0].data;

    expect(first).toEqual(
      expect.objectContaining({
        stage: STAGE_ID,
        userId: USER,
        // MAX_SLICES_PER_SWEEP slices of 2 — the hop stopped at its ceiling, not
        // at the end of the corpus.
        cursor: srcId(MAX_SLICES_PER_SWEEP * 2),
        hop: 1,
        dispatched: hops[0].result.dispatched,
        sliceSize: 2,
      }),
    );

    // The total is cumulative across the chain, not per hop: it is the only
    // number that answers "how much has this sweep dispatched so far?".
    expect(requeues[1].data.dispatched).toBe(hops[0].result.dispatched + hops[1].result.dispatched);
  });

  it('requeues a payload the next hop can parse', async () => {
    const h = makeHarness({ corpus: corpusOf(24) });

    await h.drain({ sliceSize: 2 });

    const requeues = h.enqueued.flatMap((e) => e.jobs).filter((j) => j.name === PipelineSweepEvent);
    expect(requeues.length).toBeGreaterThan(0);

    for (const job of requeues) {
      const parsed = pipelineSweepPayloadSchema.safeParse(JSON.parse(JSON.stringify(job.data)));
      expect(parsed.success).toBe(true);
    }
  });

  it('does not requeue after a short page, because a short page means drained', async () => {
    const h = makeHarness({ corpus: corpusOf(5) });

    const hops = await h.drain({ sliceSize: 3 });

    expect(hops).toHaveLength(1);
    expect(hops[0].result.exhausted).toBe(true);
    expect(h.enqueued.flatMap((e) => e.jobs).filter((j) => j.name === PipelineSweepEvent)).toHaveLength(0);
  });
});

describe('PipelineDispatchService queue routing', () => {
  it.each(PIPELINE_QUEUE_NAMES)('enqueues slices onto the queue the stage declares (%s)', async (queue) => {
    // Not a default, and not the control queue the sweep happens to have been
    // started from. A slice on a queue no worker is bound to sits until
    // retention deletes it — a backfill that reports success and does nothing.
    const h = makeHarness({ corpus: corpusOf(4), stage: { queue } });

    await h.drain({ sliceSize: 2 });

    const slices = h.sliceJobs();
    expect(slices.length).toBeGreaterThan(0);
    for (const { enqueue } of slices) {
      expect(enqueue.queue).toBe(queue);
      expect(enqueue.queue).not.toBe('default');
    }
  });

  it('requeues the next hop onto the same queue as its slices', async () => {
    // The sweep must ride WITH the work it produces; a hop on another queue
    // cannot be held behind its own slices and the backpressure evaporates.
    const h = makeHarness({ corpus: corpusOf(24), stage: { queue: PIPELINE_QUEUES.EMBED } });

    await h.drain({ sliceSize: 2 });

    for (const enqueue of h.enqueued) {
      expect(enqueue.queue).toBe(PIPELINE_QUEUES.EMBED);
    }
  });

  it('starts a sweep on the stage queue rather than a control queue', async () => {
    const h = makeHarness({ stage: { queue: PIPELINE_QUEUES.EMBED } });

    await h.service.startSweep({ stage: STAGE_ID, userId: USER });

    expect(h.enqueued[0].queue).toBe(PIPELINE_QUEUES.EMBED);
  });

  it('enqueues every slice in ONE bulk call rather than one round trip each', async () => {
    // `send()` per slice is a round trip per slice; `sendMany` is a single
    // INSERT producing byte-identical jobs.
    const h = makeHarness({ corpus: corpusOf(10) });

    const hops = await h.drain({ sliceSize: 2 });

    const bulk = hops[0].log.filter((e) => e.via === 'sendMany');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].jobs.length).toBe(MAX_SLICES_PER_SWEEP);
    // No slice ever goes out through the single-job path.
    for (const enqueue of h.enqueued.filter((e) => e.via === 'send')) {
      expect(enqueue.jobs.every((job) => job.name !== PipelineSliceEvent)).toBe(true);
    }
  });
});

describe('PipelineDispatchService backpressure ordering', () => {
  it('queues the next hop BEHIND the slices it just produced', async () => {
    // pg-boss fetches `ORDER BY priority DESC, created_on`, so at equal priority
    // the hop enqueued after its slices cannot run until they have been drained.
    // Enqueue it first and the sweep overtakes its own work: the whole corpus
    // lands on the queue in seconds and buries everything else.
    const h = makeHarness({ corpus: corpusOf(24) });

    const hops = await h.drain({ sliceSize: 2 });

    for (const { log } of hops) {
      const slicesAt = log.findIndex((e) => e.jobs.some((job) => job.name === PipelineSliceEvent));
      const sweepAt = log.findIndex((e) => e.jobs.some((job) => job.name === PipelineSweepEvent));

      if (sweepAt === -1) {
        continue;
      }

      expect(slicesAt).toBeGreaterThanOrEqual(0);
      expect(slicesAt).toBeLessThan(sweepAt);
    }
  });

  it('awaits the slice enqueue before the hop enqueue, not merely calls it first', async () => {
    // Ordering that depends on two un-awaited promises resolving in call order
    // is not ordering. The recorded call order must survive a slow bulk insert.
    const h = makeHarness({ corpus: corpusOf(24) });
    const observed: string[] = [];

    h.eventService.sendMany.mockImplementation(async (queue, jobs) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      observed.push('slices');
      h.enqueued.push({ via: 'sendMany', queue, priority: BACKFILL_JOB_PRIORITY, jobs });
    });
    h.eventService.send.mockImplementation(async (name, data, opts) => {
      observed.push(name === PipelineSweepEvent ? 'sweep' : name);
      h.enqueued.push({ via: 'send', queue: opts?.queue, priority: opts?.priority, jobs: [{ name, data }] });

      return ['job-1'];
    });

    await h.service.runSweepHop(h.sweepPayload({ sliceSize: 2 }));

    expect(observed).toEqual(['slices', 'sweep']);
  });

  it('enqueues at the backfill priority, so a sweep yields to interactive work', async () => {
    // A million-row sweep queued at 09:00 must not delay a user action queued at
    // 09:01. Priority is the only thing that reorders them.
    const h = makeHarness({ corpus: corpusOf(24) });

    await h.service.startSweep({ stage: STAGE_ID, userId: USER });
    await h.drain({ sliceSize: 2 });

    expect(h.enqueued.length).toBeGreaterThan(2);
    for (const enqueue of h.enqueued) {
      expect(enqueue.priority).toBe(BACKFILL_JOB_PRIORITY);
    }

    expect(BACKFILL_JOB_PRIORITY).toBeLessThan(DEFAULT_JOB_PRIORITY);
    expect(DEFAULT_JOB_PRIORITY).toBeLessThan(INTERACTIVE_JOB_PRIORITY);
  });

  it('gives the hop the same priority as its slices, so ordering decides, not rank', async () => {
    // A hop at a HIGHER priority than its slices jumps the queue it just filled
    // and the chain runs away; a lower one starves behind every future backfill.
    const h = makeHarness({ corpus: corpusOf(24) });

    const hops = await h.drain({ sliceSize: 2 });

    const slicePriority = hops[0].log.find((e) =>
      e.jobs.some((j) => j.name === PipelineSliceEvent),
    )?.priority;
    const sweepPriority = hops[0].log.find((e) =>
      e.jobs.some((j) => j.name === PipelineSweepEvent),
    )?.priority;

    expect(slicePriority).toBe(BACKFILL_JOB_PRIORITY);
    expect(sweepPriority).toBe(slicePriority);
  });
});

describe('PipelineDispatchService empty and bounded dispatch', () => {
  it('enqueues nothing at all when nothing is stale', async () => {
    // Not an empty slice, not a requeue, not a job of any kind. A stage that is
    // fully covered must cost one query per sweep and no queue traffic — this is
    // what makes a cron-driven sweep free on an idle appliance.
    const h = makeHarness({ corpus: corpusOf(0) });

    const hops = await h.drain({ sliceSize: 2 });

    expect(hops).toHaveLength(1);
    expect(h.enqueued).toHaveLength(0);
    expect(hops[0].result).toEqual(
      expect.objectContaining({ dispatched: 0, slices: 0, cursor: null, exhausted: true }),
    );
    expect(h.stateService.selectStale).toHaveBeenCalledTimes(1);
  });

  it('never enqueues a zero-length slice, including on the dry hop after a full one', async () => {
    // A corpus that is an exact multiple of the slice size ends with a page that
    // is empty rather than short, so the dry hop is reached with slices already
    // dispatched — the shape most likely to emit an empty job.
    const h = makeHarness({ corpus: corpusOf(10) });

    const hops = await h.drain({ sliceSize: 2 });

    expect(hops).toHaveLength(2);
    expect(hops[1].log).toHaveLength(0);
    expect(h.sliceJobs()).toHaveLength(MAX_SLICES_PER_SWEEP);

    for (const { data } of h.sliceJobs()) {
      expect((data.ids as string[]).length).toBeGreaterThan(0);
    }
  });

  it('never produces one giant job for a corpus far larger than a slice', async () => {
    // The defect this replaces: a backfill that pages the source and then works
    // the whole page inline, so a killed worker loses everything. One slice is
    // one unit of resumability and may not grow with the corpus.
    const h = makeHarness({ corpus: corpusOf(5_000) });

    const hops = await h.drain({ sliceSize: DEFAULT_SLICE_SIZE });

    const slices = h.sliceJobs();
    expect(slices).toHaveLength(5_000 / DEFAULT_SLICE_SIZE);

    for (const { data } of slices) {
      expect((data.ids as string[]).length).toBeLessThanOrEqual(DEFAULT_SLICE_SIZE);
    }

    // And no hop dumps the corpus in one pass, either.
    for (const { result } of hops) {
      expect(result.slices).toBeLessThanOrEqual(MAX_SLICES_PER_SWEEP);
    }

    expect(h.dispatchedIds()).toHaveLength(5_000);
    expect(new Set(h.dispatchedIds()).size).toBe(5_000);
  });

  it('asks the source for no more than one slice at a time', async () => {
    const h = makeHarness({ corpus: corpusOf(50) });

    await h.drain({ sliceSize: 7 });

    expect(h.selects.length).toBeGreaterThan(1);
    for (const select of h.selects) {
      expect(select.limit).toBe(7);
    }
  });

  it('emits slice payloads the generic worker can parse', async () => {
    // The slice schema is where the hard ceiling on ids per slice is enforced,
    // so validating the emitted payloads pins the bound the dispatcher is
    // responsible for staying inside.
    const h = makeHarness({ corpus: corpusOf(12) });

    await h.drain({ sliceSize: 5 });

    expect(h.sliceJobs().length).toBeGreaterThan(0);
    for (const { data } of h.sliceJobs()) {
      const parsed = pipelineSlicePayloadSchema.safeParse(JSON.parse(JSON.stringify(data)));
      expect(parsed.success).toBe(true);
    }
  });
});

describe('PipelineDispatchService per-run cap', () => {
  /**
   * `StageSchedule.perRunCap`, arriving as `maxIds`.
   *
   * The interval decides how OFTEN a metered stage bills; this decides how BIG
   * one bill can be, and it is the half that matters more. `ci.position` is
   * empty today only because a debug push used the legacy GraphQL lane — a real
   * `/v1` import fills it from 66,579 Google Fit records, and weekly-with-no-cap
   * is not a slow bill, it is one night on which 66,000 fixes hit a paid
   * provider at once.
   *
   * The contract is SLICE granularity, deliberately: trimming a page to hit an
   * exact number would emit odd-sized slices and, worse, advance the cursor to
   * an id the sweep had not finished with — so a resumed chain would re-dispatch
   * rows it had already handed out. Overshoot below one slice is the price, and
   * it is asserted as a bound rather than assumed.
   */
  it('carries the cap from startSweep into the first hop, and null when there is none', async () => {
    const capped = makeHarness();
    await capped.service.startSweep({ stage: STAGE_ID, userId: USER, maxIds: 2_000 });
    expect(capped.enqueued[0].jobs[0].data.maxIds).toBe(2_000);

    const uncapped = makeHarness();
    await uncapped.service.startSweep({ stage: STAGE_ID, userId: USER });
    // `null`, not absent and not 0: a 0 reads as "no cap" to a careless `??` and
    // as "dispatch nothing" to a careful one.
    expect(uncapped.enqueued[0].jobs[0].data.maxIds).toBeNull();
  });

  it('stops the chain at the cap and dispatches exactly it when it divides evenly', async () => {
    // `schedule.ts`'s own arithmetic for `enrich.position_reverse`, run for real:
    // 2,000 ids = 10 slices at DEFAULT_SLICE_SIZE = 2 sweep hops.
    const h = makeHarness({ corpus: corpusOf(5_000) });

    const hops = await h.drain({ sliceSize: DEFAULT_SLICE_SIZE, maxIds: 2_000 });

    expect(h.dispatchedIds()).toHaveLength(2_000);
    expect(h.sliceJobs()).toHaveLength(10);
    expect(hops).toHaveLength(2);

    // The chain ENDS. A capped hop that still requeued itself would spend a
    // worker slot per tick doing nothing, forever.
    expect(hops[hops.length - 1].result).toEqual(expect.objectContaining({ capped: true, exhausted: false }));
    expect(
      hops
        .flatMap((hop) => hop.log)
        .flatMap((e) => e.jobs)
        .filter((job) => job.name === PipelineSweepEvent),
    ).toHaveLength(1);
  });

  it('overshoots by strictly less than one slice when the cap does not divide evenly', async () => {
    const h = makeHarness({ corpus: corpusOf(5_000) });

    await h.drain({ sliceSize: DEFAULT_SLICE_SIZE, maxIds: 1_500 });

    const dispatched = h.dispatchedIds().length;

    expect(dispatched).toBeGreaterThanOrEqual(1_500);
    expect(dispatched).toBeLessThan(1_500 + DEFAULT_SLICE_SIZE);
  });

  it('bounds the WHOLE chain, not each hop', async () => {
    // The bug this pins: a cap read per hop would let every hop dispatch the
    // full cap, so a 2,000 cap over a 5,000-row corpus would bill for all 5,000
    // and the chain would look perfectly well-behaved doing it. `dispatched` is
    // the running total carried across hops, and it is what the check reads.
    const h = makeHarness({ corpus: corpusOf(5_000) });

    const hops = await h.drain({ sliceSize: 100, maxIds: 900 });

    // 5 slices of 100 per hop, so the cap lands mid-chain rather than on a hop
    // boundary — two hops in, not two hops each.
    expect(hops.length).toBeGreaterThan(1);
    expect(h.dispatchedIds().length).toBeLessThan(1_000);
  });

  it('spends no query at all once the budget is gone', async () => {
    // The check sits BEFORE the select, so a spent budget costs neither a
    // staleness query nor the slice it would have produced.
    const h = makeHarness({ corpus: corpusOf(5_000) });

    await h.drain({ sliceSize: DEFAULT_SLICE_SIZE, maxIds: 400 });

    expect(h.dispatchedIds()).toHaveLength(400);
    // Two selects, two slices, and then the hop stops — it does not page on to
    // discover that it should not have.
    expect(h.selects).toHaveLength(2);
  });

  it('reports drained rather than capped when the last slice both empties the source and spends the budget', async () => {
    // The tie. 350 rows against a cap of exactly 350: the second slice comes
    // back short — so the source IS dry — and the running total reaches the cap
    // on the same slice. Both facts are true and only one is worth reporting,
    // because `drained` is the one that says a later sweep will find nothing.
    const h = makeHarness({ corpus: corpusOf(350) });

    const hops = await h.drain({ sliceSize: DEFAULT_SLICE_SIZE, maxIds: 350 });

    expect(h.dispatchedIds()).toHaveLength(350);
    expect(hops[hops.length - 1].result).toEqual(expect.objectContaining({ exhausted: true, capped: false }));
  });

  it('reports capped when the budget runs out before the source is known to be dry', async () => {
    // A corpus that is an exact multiple of the slice size: every page is full,
    // so nothing has PROVEN the source empty when the budget goes. Reported as
    // capped, and the cheaper answer — the check sits before the select
    // precisely so the sweep does not spend a query to discover it could have
    // said `drained` instead. Nothing downstream depends on the difference: the
    // tick's own probe decides whether the leg is drained.
    const h = makeHarness({ corpus: corpusOf(400) });

    const hops = await h.drain({ sliceSize: DEFAULT_SLICE_SIZE, maxIds: 400 });

    expect(h.dispatchedIds()).toHaveLength(400);
    expect(hops[hops.length - 1].result).toEqual(expect.objectContaining({ exhausted: false, capped: true }));
  });

  it('leaves an uncapped sweep completely unbounded, which is what every free stage gets', async () => {
    const h = makeHarness({ corpus: corpusOf(5_000) });

    await h.drain({ sliceSize: DEFAULT_SLICE_SIZE });

    expect(h.dispatchedIds()).toHaveLength(5_000);
  });

  it('carries the cap through a payload round trip, so a resumed hop still honours it', async () => {
    // The chain outlives the process that started it: every hop is re-parsed
    // from `pgboss.job.data`. A cap that did not survive JSON would silently
    // become uncapped on the second hop — the exact hop where it starts to
    // matter.
    const h = makeHarness({ corpus: corpusOf(5_000) });

    await h.service.startSweep({ stage: STAGE_ID, userId: USER, maxIds: 2_000 });

    const first = pipelineSweepPayloadSchema.parse(JSON.parse(JSON.stringify(h.enqueued[0].jobs[0].data)));

    expect(first.maxIds).toBe(2_000);

    const hop = await h.service.runSweepHop(first);
    const requeued = h.enqueued
      .flatMap((e) => e.jobs)
      .filter((job) => job.name === PipelineSweepEvent)
      .at(-1);

    expect(hop.capped).toBe(false);
    expect(pipelineSweepPayloadSchema.parse(JSON.parse(JSON.stringify(requeued?.data))).maxIds).toBe(2_000);
  });
});

describe('PipelineDispatchService entity types', () => {
  it('stamps the stage single entity type on every slice and every query', async () => {
    const h = makeHarness({ corpus: corpusOf(6) });

    await h.drain({ sliceSize: 2 });

    expect(h.selects.length).toBeGreaterThan(0);
    for (const select of h.selects) {
      expect(select.entityType).toBe(ENTITY_TYPE);
    }

    expect(h.sliceJobs()).toHaveLength(3);
    for (const { data } of h.sliceJobs()) {
      expect(data.entityType).toBe(ENTITY_TYPE);
      expect(data.stage).toBe(STAGE_ID);
      expect(data.userId).toBe(USER);
    }
  });

  it('refuses a multi-type stage sweep that names no entity type, enqueuing nothing', async () => {
    // The ledger is keyed per (entity_type, entity_id, stage). Defaulting to the
    // first declared type records one type's progress under another's key, and
    // both sweeps then read the ledger wrong in opposite directions.
    const h = makeHarness({
      corpus: corpusOf(6),
      stage: { entityTypes: ['file', 'contact'] },
    });

    await expect(h.service.runSweepHop(h.sweepPayload({ sliceSize: 2 }))).rejects.toThrow(/entityType/i);
    expect(h.stateService.selectStale).not.toHaveBeenCalled();
    expect(h.enqueued).toHaveLength(0);
  });

  it('sweeps the named type when a multi-type stage is told which one', async () => {
    const h = makeHarness({
      corpus: corpusOf(4),
      stage: { entityTypes: ['file', 'contact'] },
    });

    await h.drain({ entityType: 'contact', sliceSize: 2 });

    expect(h.selects.length).toBeGreaterThan(0);
    for (const select of h.selects) {
      expect(select.entityType).toBe('contact');
    }

    expect(h.sliceJobs()).toHaveLength(2);
    for (const { data } of h.sliceJobs()) {
      expect(data.entityType).toBe('contact');
    }
  });

  it('keeps sweeping the same type across the whole chain', async () => {
    // A hop that dropped the type would re-derive it from the stage and, for a
    // multi-type stage, either throw mid-chain or silently switch corpora.
    const h = makeHarness({
      corpus: corpusOf(24),
      stage: { entityTypes: ['file', 'contact'] },
    });

    const hops = await h.drain({ entityType: 'contact', sliceSize: 2 });

    expect(hops.length).toBeGreaterThan(1);
    expect(h.dispatchedIds()).toEqual(corpusOf(24));
    for (const select of h.selects) {
      expect(select.entityType).toBe('contact');
    }
  });
});
