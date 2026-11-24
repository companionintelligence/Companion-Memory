import { ContentCreatedEvent } from '@ci/domains/memory/events';

import { DEFAULT_SLICE_SIZE, PIPELINE_CONTROL_QUEUE, PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import { PipelineSliceEvent } from '../../events';
import { STAGE_SCHEDULES } from '../../schedule';
import {
  QUEUE_READY_CAPS,
  type QueueAdmission,
  type QueueAdmissions,
} from '../../services/BackpressureService';
import { pipelineSlicePayloadSchema, type Stage, type StageResult, type StageSchedule } from '../../types';
import { PipelineSliceListener } from '../PipelineSliceListener';
import {
  ARRIVAL_COALESCE_WINDOW_MS,
  ARRIVAL_SIGNALS,
  MAX_PENDING_ARRIVALS,
  StageArrivalListener,
  assertArrivalSignals,
  type ArrivalSignal,
} from '../StageArrivalListener';

/**
 * ARRIVAL DISPATCH — "process things as they come in", with the sweep as the net.
 *
 * Four claims are pinned here, and each one is a property the pipeline would
 * otherwise lose silently:
 *
 *  1. **Only `onArrival` stages react.** A `scheduled` stage triggered by
 *     arrival is an unbudgeted job per imported row; a metered one is an
 *     unbudgeted CHARGE per imported row. The guard is asserted, and so is the
 *     executing path, because a guard that only runs at boot cannot protect a
 *     signal assembled at runtime.
 *  2. **A flood COALESCES.** 309,689 records in 50 seconds was measured on this
 *     appliance. The assertion is on the NUMBER OF JOBS, not on "it works" —
 *     job count is the only place the bus's previous fan-out defect (~93 %
 *     waste) was ever visible, and nothing failed while it was happening.
 *  3. **Shedding is not losing.** This is the property the whole design rests
 *     on: an arrival refused under backpressure writes nothing, so the row is
 *     still stale and the next sweep selects it. The test therefore does not
 *     merely assert "nothing was enqueued" — it runs a real staleness selection
 *     afterwards and requires the row to come back.
 *  4. **An arrival and a sweep cannot both process a row.** Not by avoiding the
 *     race, but by going through the same ledger claim the sweep does. The test
 *     drives BOTH slices through the real `PipelineSliceListener` against one
 *     ledger and requires the stage to see the row exactly once.
 *
 * The ledger fake below models the two statements those claims depend on —
 * `selectStale`'s three staleness arms and `claim`'s "one winner" conflict guard
 * — because a mock that answers however the test wants could satisfy claims 3
 * and 4 while the real thing did the opposite.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';

/** The one stage that ships on `trigger: 'onArrival'`. */
const ARRIVAL_STAGE = STAGE_IDS.INDEX_EMBED;

/** A stage that ships on `trigger: 'scheduled'`, used as the negative case. */
const SCHEDULED_STAGE = STAGE_IDS.ENRICH_MEDIA_DIMENSIONS;

function srcId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** `@nestjs/event-emitter`'s metadata key. Not exported from the package root. */
const EVENT_LISTENER_METADATA = 'EVENT_LISTENER_METADATA';

/**
 * Every queue-qualified event name this prototype's methods are decorated with.
 *
 * The domain's `@OnEvent` registers `${eventName}:${queue}` with the base
 * decorator, so what comes back is exactly the routing key the bus uses.
 */
function boundEventNames(prototype: object): string[] {
  const names: string[] = [];

  for (const key of Object.getOwnPropertyNames(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);

    if (typeof descriptor?.value !== 'function') {
      continue;
    }

    const metadata = Reflect.getMetadata(EVENT_LISTENER_METADATA, descriptor.value) as
      Array<{ event: string }> | undefined;

    for (const entry of metadata ?? []) {
      names.push(entry.event);
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface StageStub extends Stage {
  run: jest.Mock<Promise<Map<string, StageResult>>, [unknown, string[]]>;
}

function makeStage(overrides: Partial<Stage> = {}): StageStub {
  const run = jest.fn(
    async (_ctx: unknown, ids: string[]) =>
      new Map<string, StageResult>(ids.map((id) => [id, { outcome: 'done' as const }])),
  );

  return {
    id: ARRIVAL_STAGE,
    version: 3,
    queue: PIPELINE_QUEUES.EMBED,
    entityTypes: ['content'],
    source: { schema: 'ci', table: 'content', idColumn: 'id', userColumn: 'user_id' },
    run,
    ...overrides,
  } as StageStub;
}

/**
 * A ledger with the two behaviours the race and shed tests depend on.
 *
 * `selectStale` implements THE ONE RULE's three arms (no row / below version /
 * failed-and-due) and `claim` implements the conflict guard's "a row already
 * running at this version is not claimable" — which is what makes "an arrival
 * and a sweep cannot both process the same row" a property rather than a
 * coincidence of ordering.
 */
function makeLedger(stage: Stage) {
  const rows = new Map<string, { version: number; status: string }>();

  return {
    rows,

    selectStale(_stage: Stage, _userId: string, _cursor: string | null, limit: number, ids: string[]) {
      return ids
        .filter((id) => {
          const row = rows.get(id);

          if (row == null) {
            return true;
          }

          return row.version < stage.version || row.status === 'failed';
        })
        .slice(0, limit);
    },

    claim: jest.fn(async (claimStage: { id: string; version: number }, _type: string, ids: string[]) => {
      const won: string[] = [];

      for (const id of ids) {
        const row = rows.get(id);

        // Already running, or already terminal at this version: somebody else
        // owns the outcome. This is the half of the claim that de-duplicates an
        // arrival racing a sweep.
        if (row != null && (row.status === 'running' || row.version >= claimStage.version)) {
          continue;
        }

        rows.set(id, { version: 0, status: 'running' });
        won.push(id);
      }

      return won;
    }),

    complete: jest.fn(
      async (
        completeStage: { id: string; version: number },
        _type: string,
        results: Map<string, StageResult>,
      ) => {
        for (const [id, result] of results) {
          rows.set(id, { version: completeStage.version, status: result.outcome });
        }

        return { done: results.size, skipped: 0, failed: 0, quarantined: 0 };
      },
    ),

    fail: jest.fn(async () => ({ done: 0, skipped: 0, failed: 0, quarantined: 0 })),
    recordDeadLetter: jest.fn(async () => undefined),
  };
}

type Ledger = ReturnType<typeof makeLedger>;

/**
 * One queue's admission.
 *
 * `grant` is the field that matters: `QueueAdmission.slices` is a COUNT of
 * slices the caller may start, and `admitted` is only `slices > 0`. A listener
 * that read the boolean and then enqueued whatever it had would re-create the
 * cliff the graded grant exists to remove, so the tests below drive the count.
 */
function admission(queue: string, grant: number): QueueAdmission {
  return {
    queue: queue as QueueAdmission['queue'],
    admitted: grant > 0,
    slices: grant,
    reason: grant > 0 ? 'ok' : 'queue_depth',
    ready: grant > 0 ? 0 : 999,
    saturated: grant <= 0,
    cap: 25,
    burst: 20,
    reopenAt: 18,
    latched: grant <= 0,
    measuredAt: new Date(),
  };
}

function admissions(grant: number): QueueAdmissions {
  const map: QueueAdmissions = new Map();

  for (const queue of Object.values(PIPELINE_QUEUES)) {
    map.set(queue, admission(queue, grant));
  }

  return map;
}

/** Enough slices that no test hits the grant unless it means to. */
const WIDE_OPEN = 1_000;

interface HarnessOptions {
  /** Slices every pipeline queue will grant. Defaults to more than any test needs. */
  grant?: number;
  /** Signals this instance reacts to. Defaults to the shipped declaration. */
  signals?: readonly ArrivalSignal[];
  /** Rows that exist in the source table, id -> owner. */
  owners?: Map<string, string>;
  /** Extra stages resolvable by id, beyond the arrival stage. */
  stages?: Record<string, Stage>;
}

function makeHarness(options: HarnessOptions = {}) {
  const stage = makeStage();
  const owners = options.owners ?? new Map<string, string>();
  const ledger = makeLedger(stage);

  const stages: Record<string, Stage> = { [ARRIVAL_STAGE]: stage, ...(options.stages ?? {}) };

  const stageRegistry = {
    get: jest.fn((stageId: string) => {
      const found = stages[stageId];

      if (found == null) {
        throw new Error(`Unknown pipeline stage "${stageId}".`);
      }

      return found;
    }),
    has: jest.fn((stageId: string) => stages[stageId] != null),
    stageIds: jest.fn(() => Object.keys(stages)),
  };

  const grant = options.grant ?? WIDE_OPEN;

  const backpressure = {
    snapshot: jest.fn(async () => admissions(grant)),
    admissible: jest.fn(async () => grant),
    admits: jest.fn(async () => grant > 0),
    check: jest.fn(async () => admission(PIPELINE_QUEUES.EMBED, grant)),
  };

  type SliceJob = { name: string; data: Record<string, unknown> };

  // Typed through the legacy `jest.fn<Return, Args>` form so `mock.calls`
  // destructures — the assertions read the queue and the job array positionally.
  const eventService = {
    send: jest.fn<Promise<string[]>, [string, Record<string, unknown>, unknown?]>(async () => ['job-1']),
    sendMany: jest.fn<Promise<void>, [string, SliceJob[], unknown?]>(async () => undefined),
  };

  /** The resolve statement, answered from `owners` and the stage's predicate. */
  const dataSource = {
    query: jest.fn(async (_sql: string, params: unknown[]) => {
      const ids = (params[0] ?? []) as string[];

      return ids.filter((id) => owners.has(id)).map((id) => ({ id, user_id: owners.get(id) as string }));
    }),
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  class TestArrivalListener extends StageArrivalListener {
    protected readonly signals = options.signals ?? ARRIVAL_SIGNALS;
  }

  const listener = new TestArrivalListener(
    dataSource as never,
    stageRegistry as never,
    backpressure as never,
    eventService as never,
    logger as never,
  );

  /** Every slice payload enqueued, in order, parsed through the real schema. */
  function slices() {
    return eventService.sendMany.mock.calls.flatMap(([queue, batch]) =>
      batch.map((job) => ({
        queue,
        name: job.name,
        payload: pipelineSlicePayloadSchema.parse(job.data),
      })),
    );
  }

  return { listener, stage, ledger, stageRegistry, backpressure, eventService, dataSource, logger, slices };
}

/**
 * The real slice worker, over the same ledger, so a test can execute a slice the
 * arrival listener produced exactly as production would.
 */
function makeSliceWorker(stage: Stage, ledger: Ledger) {
  const registry = { get: jest.fn(() => stage) };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  return new PipelineSliceListener(registry as never, ledger as never, logger as never);
}

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

describe('ARRIVAL_SIGNALS', () => {
  it('passes its own boot guard as shipped', () => {
    expect(() => assertArrivalSignals()).not.toThrow();
  });

  it('names only stages the schedule declares onArrival', () => {
    for (const signal of ARRIVAL_SIGNALS) {
      for (const stageId of signal.stages) {
        expect(STAGE_SCHEDULES[stageId].trigger).toBe('onArrival');
      }
    }
  });

  it('covers every onArrival stage — a stage nothing signals silently degrades to its sweep', () => {
    const signalled = new Set(ARRIVAL_SIGNALS.flatMap((signal) => [...signal.stages]));

    for (const [stageId, schedule] of Object.entries(STAGE_SCHEDULES)) {
      if (schedule.trigger === 'onArrival') {
        expect(signalled.has(stageId as never)).toBe(true);
      }
    }
  });

  it('binds every declared signal to a listener on the control queue', () => {
    // The declaration the boot guard structurally cannot see: it compares
    // ARRIVAL_SIGNALS to STAGE_SCHEDULES, and a signal with no `@OnEvent` method
    // is consistent with both while the stage never hears an arrival at all.
    //
    // Read off the decorator's own metadata rather than through
    // `EventListenerRegistry`, which lives in another domain's internals and is
    // not on its public barrel. `EVENT_LISTENER_METADATA` is
    // `@nestjs/event-emitter`'s key and is not exported from the package root
    // either, so it is spelled out — if that ever changes, this test fails
    // loudly rather than passing vacuously, which is the right failure for an
    // assertion about wiring.
    const bound = boundEventNames(StageArrivalListener.prototype);

    expect(bound.length).toBeGreaterThan(0);

    for (const signal of ARRIVAL_SIGNALS) {
      expect(bound).toContain(`${signal.event}:${PIPELINE_CONTROL_QUEUE}`);
    }
  });

  it('binds nothing an ARRIVAL_SIGNALS entry does not declare', () => {
    // A binding with no signal is a per-row pg-boss job on every emit of that
    // event that this listener then ignores — the fan-out defect, one event at
    // a time.
    const declared = ARRIVAL_SIGNALS.map((signal) => `${signal.event}:${PIPELINE_CONTROL_QUEUE}`);

    expect(boundEventNames(StageArrivalListener.prototype).sort()).toEqual(declared.sort());
  });

  it('rides the pipeline housekeeping queue, which has the most headroom', () => {
    // An arrival note bound to `pipeline-embed` would count toward THAT queue's
    // ready depth, so the backpressure gate would shed the slices to make room
    // for the notifications about them. The control queue is Postgres-bound and
    // already carries sweep hops and dead-letter reaps.
    expect(PIPELINE_CONTROL_QUEUE).toBe(PIPELINE_QUEUES.INDEX);
    expect(QUEUE_READY_CAPS[PIPELINE_CONTROL_QUEUE]).toBe(Math.max(...Object.values(QUEUE_READY_CAPS)));
  });

  describe('the boot guard', () => {
    const schedules = STAGE_SCHEDULES as unknown as Record<string, StageSchedule>;

    it('refuses a signal naming a scheduled stage', () => {
      expect(() =>
        assertArrivalSignals(
          [
            { event: ContentCreatedEvent, idField: 'contentId', stages: [ARRIVAL_STAGE] },
            { event: 'file.created', idField: 'fileId', stages: [SCHEDULED_STAGE] },
          ],
          schedules,
        ),
      ).toThrow(/scheduled/);
    });

    it('refuses a signal naming a stage that does not exist', () => {
      expect(() =>
        assertArrivalSignals(
          [
            { event: ContentCreatedEvent, idField: 'contentId', stages: [ARRIVAL_STAGE] },
            { event: 'nope.created', idField: 'id', stages: ['enrich.imaginary' as never] },
          ],
          schedules,
        ),
      ).toThrow(/enrich\.imaginary/);
    });

    it('refuses an onArrival stage that no signal names', () => {
      expect(() => assertArrivalSignals([], schedules)).toThrow(new RegExp(ARRIVAL_STAGE));
    });

    it('refuses two signals for one event', () => {
      expect(() =>
        assertArrivalSignals(
          [
            { event: ContentCreatedEvent, idField: 'contentId', stages: [ARRIVAL_STAGE] },
            { event: ContentCreatedEvent, idField: 'contentId', stages: [ARRIVAL_STAGE] },
          ],
          schedules,
        ),
      ).toThrow(/declared twice/);
    });
  });
});

// ---------------------------------------------------------------------------
// An arrival dispatches that row
// ---------------------------------------------------------------------------

describe('an arrival', () => {
  it('enqueues a slice for THAT row, not a sweep', async () => {
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    const report = await h.listener.flush();

    // A sweep is a query over the corpus; an arrival already knows the id. If
    // this ever becomes a sweep, one imported row costs an anti-join over
    // 324,044 rows.
    expect(h.eventService.send).not.toHaveBeenCalled();

    const slices = h.slices();
    expect(slices).toHaveLength(1);
    expect(slices[0].name).toBe(PipelineSliceEvent);
    expect(slices[0].queue).toBe(PIPELINE_QUEUES.EMBED);
    expect(slices[0].payload).toEqual(
      expect.objectContaining({ stage: ARRIVAL_STAGE, entityType: 'content', userId: USER, ids: [srcId(1)] }),
    );
    expect(report).toEqual(expect.objectContaining({ arrivals: 1, dispatched: 1, slices: 1 }));
  });

  it('produces a payload the slice worker accepts unchanged', () => {
    // The arrival path is only safe because its job is byte-identical to the
    // sweep's: same event, same schema, same worker, same claim.
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });

    return h.listener.flush().then(() => {
      const [slice] = h.slices();

      expect(() => pipelineSlicePayloadSchema.parse(slice.payload)).not.toThrow();
      expect(slice.payload.runId ?? null).toBeNull();
      expect(slice.payload.shardId ?? null).toBeNull();
    });
  });

  it('never writes the ledger itself — the claim belongs to the slice worker', async () => {
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    await h.listener.flush();

    expect(h.ledger.claim).not.toHaveBeenCalled();
    expect(h.ledger.complete).not.toHaveBeenCalled();
    expect(h.ledger.rows.size).toBe(0);
  });

  it('splits one flush across owners, because a slice carries exactly one user', async () => {
    const h = makeHarness({
      owners: new Map([
        [srcId(1), USER],
        [srcId(2), OTHER_USER],
      ]),
    });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(2) });
    await h.listener.flush();

    const slices = h.slices();
    expect(slices).toHaveLength(2);
    expect(new Set(slices.map((slice) => slice.payload.userId))).toEqual(new Set([USER, OTHER_USER]));
  });

  it('drops an id the source no longer has, without enqueuing anything for it', async () => {
    // Created and deleted inside one window, or owned by nobody. The resolve
    // answers with fewer rows than were asked for and that is the whole handling.
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(2) });
    const report = await h.listener.flush();

    expect(report.notApplicable).toBe(1);
    expect(h.slices().flatMap((slice) => slice.payload.ids)).toEqual([srcId(1)]);
  });

  it('drops a payload with no usable id rather than failing the job', async () => {
    // A throw here spends the notification's three pg-boss retries and
    // dead-letters a payload that will never parse. Nothing is lost by dropping
    // it: no ledger row was written, so the row is still stale.
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });

    expect(() => h.listener.noteArrival(ContentCreatedEvent, { wrongField: srcId(1) })).not.toThrow();
    expect(() => h.listener.noteArrival(ContentCreatedEvent, null)).not.toThrow();

    const report = await h.listener.flush();

    expect(report.arrivals).toBe(0);
    expect(h.eventService.sendMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Only onArrival stages react
// ---------------------------------------------------------------------------

describe('trigger discipline', () => {
  it('dispatches an onArrival stage and NOT a scheduled one named by the same arrival', async () => {
    // The difference between a prompt embed and an unbudgeted job per imported
    // row — and, for a metered stage, an unbudgeted charge per imported row.
    const scheduledStage = makeStage({
      id: SCHEDULED_STAGE,
      queue: PIPELINE_QUEUES.ENRICH,
      entityTypes: ['file'],
      source: { schema: 'ci', table: 'files', idColumn: 'id', userColumn: 'user_id' },
    });

    const h = makeHarness({
      owners: new Map([[srcId(1), USER]]),
      stages: { [SCHEDULED_STAGE]: scheduledStage },
      signals: [
        {
          event: ContentCreatedEvent,
          idField: 'contentId',
          stages: [ARRIVAL_STAGE, SCHEDULED_STAGE],
        },
      ],
    });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    await h.listener.flush();

    const stagesDispatched = h.slices().map((slice) => slice.payload.stage);
    expect(stagesDispatched).toEqual([ARRIVAL_STAGE]);
    expect(stagesDispatched).not.toContain(SCHEDULED_STAGE);
    // Not even resolved: a stage that may not be triggered is refused before it
    // costs a registry lookup or a resolve query.
    expect(h.stageRegistry.get).not.toHaveBeenCalledWith(SCHEDULED_STAGE);
  });

  it('ignores an arrival for an event nothing declares', async () => {
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival('nobody.declared.this', { contentId: srcId(1) });
    const report = await h.listener.flush();

    expect(report.arrivals).toBe(0);
    expect(h.eventService.sendMany).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

describe('coalescing a flood', () => {
  /** 309,689 records in 50 s was measured; this is one window's worth of it. */
  const FLOOD = 10_000;

  function flood(h: ReturnType<typeof makeHarness>, count: number): void {
    for (let i = 1; i <= count; i += 1) {
      h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(i) });
    }
  }

  function ownersFor(count: number): Map<string, string> {
    const owners = new Map<string, string>();

    for (let i = 1; i <= count; i += 1) {
      owners.set(srcId(i), USER);
    }

    return owners;
  }

  it('turns a flood into a handful of jobs, not one job per row', async () => {
    const h = makeHarness({ owners: ownersFor(FLOOD) });

    flood(h, FLOOD);
    const report = await h.listener.flush();

    // THE assertion: the job COUNT. The bus's previous fan-out defect was
    // ~93 % waste and nothing failed while it happened, so "it works" would
    // have passed then too.
    const expectedSlices = MAX_PENDING_ARRIVALS / DEFAULT_SLICE_SIZE;
    expect(report.slices).toBe(expectedSlices);
    expect(report.slices).toBeLessThanOrEqual(5);
    expect(h.slices()).toHaveLength(expectedSlices);

    // One bulk insert, not one round trip per slice.
    expect(h.eventService.sendMany).toHaveBeenCalledTimes(1);
    expect(h.eventService.send).not.toHaveBeenCalled();

    // One resolve statement for the whole flush, not one per row.
    expect(h.dataSource.query).toHaveBeenCalledTimes(1);
  });

  it('bounds the buffer, and the shed rows stay stale for the sweep', async () => {
    const h = makeHarness({ owners: ownersFor(FLOOD) });

    flood(h, FLOOD);
    const report = await h.listener.flush();

    expect(report.arrivals).toBe(MAX_PENDING_ARRIVALS);
    expect(report.shedByOverflow).toBe(FLOOD - MAX_PENDING_ARRIVALS);

    // The rows dropped at the buffer ceiling were never written anywhere, so a
    // sweep still finds every one of them.
    const shedId = srcId(FLOOD);
    expect(h.ledger.rows.has(shedId)).toBe(false);
    expect(h.ledger.selectStale(h.stage, USER, null, 10, [shedId])).toEqual([shedId]);
  });

  it('counts an id arriving twice in one window once', async () => {
    const h = makeHarness({ owners: ownersFor(1) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });

    const report = await h.listener.flush();

    expect(report.arrivals).toBe(1);
    expect(h.slices()).toHaveLength(1);
    expect(h.slices()[0].payload.ids).toEqual([srcId(1)]);
  });

  it('chunks one owner’s ids at DEFAULT_SLICE_SIZE', async () => {
    const count = DEFAULT_SLICE_SIZE + 1;
    const h = makeHarness({ owners: ownersFor(count) });

    flood(h, count);
    await h.listener.flush();

    const slices = h.slices();
    expect(slices).toHaveLength(2);
    expect(slices[0].payload.ids).toHaveLength(DEFAULT_SLICE_SIZE);
    expect(slices[1].payload.ids).toHaveLength(1);
  });

  describe('the window', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('flushes on its own after the window elapses', async () => {
      const h = makeHarness({ owners: ownersFor(1) });

      h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
      expect(h.eventService.sendMany).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(ARRIVAL_COALESCE_WINDOW_MS);

      expect(h.eventService.sendMany).toHaveBeenCalledTimes(1);
    });

    it('is a FIXED window, so a sustained stream still flushes', async () => {
      // A sliding debounce is the obvious implementation and it never fires
      // during a flood — re-armed by every arrival, so the mechanism meant to
      // absorb the flood is the one the flood switches off.
      const h = makeHarness({ owners: ownersFor(100) });

      const step = ARRIVAL_COALESCE_WINDOW_MS / 4;

      for (let i = 1; i <= 8; i += 1) {
        h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(i) });
        await jest.advanceTimersByTimeAsync(step);
      }

      expect(h.eventService.sendMany).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Shedding under backpressure
// ---------------------------------------------------------------------------

describe('under backpressure', () => {
  it('enqueues nothing, AND leaves the row stale so the next sweep finds it', async () => {
    // THE property that makes shedding correct rather than lossy, and the reason
    // there is no deferral queue in this listener: the ledger is the source of
    // truth for "has this run?", so a shed arrival is simply a row that is still
    // stale. Asserting "nothing was enqueued" alone would pass for a listener
    // that had silently marked the row done.
    const h = makeHarness({ grant: 0, owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    const report = await h.listener.flush();

    expect(h.eventService.sendMany).not.toHaveBeenCalled();
    expect(h.eventService.send).not.toHaveBeenCalled();
    expect(report.shedByBackpressure).toBe(1);
    expect(report.slices).toBe(0);

    // Nothing was written, so the sweep re-derives the work from scratch.
    expect(h.ledger.rows.size).toBe(0);
    expect(h.ledger.selectStale(h.stage, USER, null, 10, [srcId(1)])).toEqual([srcId(1)]);
  });

  it('takes exactly the slices the queue grants, and sheds the rest', async () => {
    // `QueueAdmission.slices` is a count, not a verdict. A listener that read
    // `admitted` and then enqueued everything it had would re-create the cliff:
    // full speed until the cap, then nothing. Two slices granted means two
    // slices enqueued, and the remainder is shed rather than deferred.
    const count = DEFAULT_SLICE_SIZE * 4;
    const owners = new Map<string, string>();

    for (let i = 1; i <= count; i += 1) {
      owners.set(srcId(i), USER);
    }

    const h = makeHarness({ grant: 2, owners });

    for (let i = 1; i <= count; i += 1) {
      h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(i) });
    }

    const report = await h.listener.flush();

    expect(report.slices).toBe(2);
    expect(report.dispatched).toBe(DEFAULT_SLICE_SIZE * 2);
    expect(report.shedByBackpressure).toBe(DEFAULT_SLICE_SIZE * 2);
    expect(h.slices()).toHaveLength(2);

    // The shed half was never written, so it is still stale.
    const shedId = srcId(count);
    expect(h.slices().flatMap((slice) => slice.payload.ids)).not.toContain(shedId);
    expect(h.ledger.selectStale(h.stage, USER, null, 10, [shedId])).toEqual([shedId]);
  });

  it('keeps no deferred copy of what it shed', async () => {
    // A shed arrival must not come back on its own: the next window flushes
    // nothing, because remembering it would be a second, in-memory, lossy copy
    // of a fact `ci.pipeline_state` already holds durably.
    const h = makeHarness({ grant: 0, owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    await h.listener.flush();

    const second = await h.listener.flush();

    expect(second.arrivals).toBe(0);
    expect(h.eventService.sendMany).not.toHaveBeenCalled();
  });

  it('logs the shed at debug with a count', async () => {
    const h = makeHarness({ grant: 0, owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    await h.listener.flush();

    expect(h.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Shed'),
      expect.objectContaining({ shed: 1, stage: ARRIVAL_STAGE }),
    );
  });

  it('measures admission once for the whole flush', async () => {
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    await h.listener.flush();

    expect(h.backpressure.snapshot).toHaveBeenCalledTimes(1);
  });

  it('sheds rather than throws when the resolve fails', async () => {
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });
    h.dataSource.query.mockRejectedValueOnce(new Error('connection terminated'));

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });

    await expect(h.listener.flush()).resolves.toEqual(expect.objectContaining({ slices: 0 }));
    expect(h.ledger.rows.size).toBe(0);
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('drops the buffer on shutdown instead of flushing into a closing DataSource', async () => {
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    h.listener.onModuleDestroy();

    const report = await h.listener.flush();

    expect(report.arrivals).toBe(0);
    expect(h.eventService.sendMany).not.toHaveBeenCalled();
    // Same argument as every other shed: nothing was written, so the row is
    // still stale.
    expect(h.ledger.selectStale(h.stage, USER, null, 10, [srcId(1)])).toEqual([srcId(1)]);
  });
});

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

describe('an arrival racing a sweep', () => {
  it('processes the row exactly once — both go through the same ledger claim', async () => {
    // Not by avoiding the race: the arrival slice and the sweep slice are the
    // same event with the same payload shape, worked by the same listener, and
    // `claim()`'s conflict guard lets exactly one of them take the row.
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });

    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    await h.listener.flush();

    const arrivalSlice = h.slices()[0].payload;

    // What a sweep would have produced for the same row: the ledger has no entry
    // for it, so THE ONE RULE selects it.
    expect(h.ledger.selectStale(h.stage, USER, null, 10, [srcId(1)])).toEqual([srcId(1)]);

    const sweepSlice = {
      stage: h.stage.id,
      entityType: 'content',
      userId: USER,
      ids: [srcId(1)],
      runId: null,
      shardId: null,
    };

    const worker = makeSliceWorker(h.stage, h.ledger);

    await worker.handleSlice(PIPELINE_QUEUES.EMBED, arrivalSlice);
    await worker.handleSlice(PIPELINE_QUEUES.EMBED, sweepSlice);

    // The stage saw the row once. The loser claimed nothing and did nothing.
    const processed = h.stage.run.mock.calls.flatMap(([, ids]) => ids);
    expect(processed).toEqual([srcId(1)]);
    expect(h.ledger.claim).toHaveBeenCalledTimes(2);
    expect(h.ledger.rows.get(srcId(1))).toEqual({ version: h.stage.version, status: 'done' });
  });

  it('does not re-run a row a sweep already completed at this version', async () => {
    const h = makeHarness({ owners: new Map([[srcId(1), USER]]) });
    const worker = makeSliceWorker(h.stage, h.ledger);

    // The sweep gets there first and finishes.
    await worker.handleSlice(PIPELINE_QUEUES.EMBED, {
      stage: h.stage.id,
      entityType: 'content',
      userId: USER,
      ids: [srcId(1)],
    });

    h.stage.run.mockClear();

    // The arrival lands afterwards — a replayed dead letter, or a slow bus hop.
    h.listener.noteArrival(ContentCreatedEvent, { contentId: srcId(1) });
    await h.listener.flush();
    await worker.handleSlice(PIPELINE_QUEUES.EMBED, h.slices()[0].payload);

    // The claim refuses an id already terminal at the current version, so the
    // arrival costs an enqueue and nothing else. The arrival path deliberately
    // does not re-implement that check: there is one definition of "stale".
    expect(h.stage.run).not.toHaveBeenCalled();
  });
});
