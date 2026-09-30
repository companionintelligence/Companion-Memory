import type { ImportRun } from '../../entities/ImportRunEntity';
import type { ImportStage } from '../../entities/ImportStageEntity';
import { buildActiveSnapshot, classifyStages, idleSnapshot } from '../activeImportSnapshot';

/**
 * The queue reasoning, pinned against the batch it was written for.
 *
 * Every fixture below is real: a 13-source inbox import observed mid-flight on
 * 2026-08-19, one run per top-level folder. What made it worth building was that
 * the UI could not tell any of it apart — thirteen rows reading "qa-full-corpus",
 * every one of them "queued", one of which had been queued for 51 minutes
 * because the appliance runs exactly one stage at a time, and one of which was
 * a 704k-item Takeout parse that had legitimately taken 45 minutes.
 *
 * So the assertions here are about the four claims that separate those cases:
 *
 *   1. a run is named by its UNIT (`google-takeout`), not its batch label;
 *   2. `waiting` (enqueued, needs the slot) is not `blocked` (its own run has
 *      not reached this stage yet), even though both are `status: 'queued'`;
 *   3. a waiting stage knows its POSITION and how long it has been waiting;
 *   4. a failed stage carries its error up where a caller will trip over it.
 */

const NOW = new Date('2026-08-19T01:24:00Z');

function run(overrides: Partial<ImportRun> = {}): ImportRun {
  return {
    id: 'run-takeout',
    userId: 'user-1',
    label: 'qa-full-corpus',
    source: 'api',
    dataSources: [],
    declaredSources: null,
    status: 'running',
    percent: 55,
    requestedStages: ['unpack', 'parse', 'media', 'push'],
    error: null,
    createdAt: new Date('2026-08-19T00:17:59Z'),
    updatedAt: NOW,
    startedAt: new Date('2026-08-19T00:18:17Z'),
    finishedAt: null,
    ...overrides,
  } as ImportRun;
}

function stage(overrides: Partial<ImportStage> = {}): ImportStage {
  return {
    id: 'stage-1',
    runId: 'run-takeout',
    seq: 0,
    kind: 'unpack',
    status: 'completed',
    phase: 'expanded',
    processed: 1,
    total: 1,
    weight: 20,
    itemsPerSec: null,
    etaSeconds: null,
    durationMs: 1872,
    detail: {},
    error: null,
    updatedAt: NOW,
    startedAt: new Date('2026-08-19T00:18:17Z'),
    finishedAt: new Date('2026-08-19T00:18:19Z'),
    ...overrides,
  } as ImportStage;
}

/** The Takeout run exactly as observed: unpack + parse done, media/push queued. */
const TAKEOUT_STAGES: ImportStage[] = [
  stage(),
  stage({
    id: 'stage-parse',
    seq: 1,
    kind: 'parse',
    status: 'completed',
    phase: 'parsing google_purchases (48/56)',
    processed: 703_956,
    total: 703_956,
    weight: 35,
    itemsPerSec: 554.9437648218284,
    durationMs: 2_734_458,
    startedAt: new Date('2026-08-19T00:18:19Z'),
    finishedAt: new Date('2026-08-19T01:04:06Z'),
  }),
  stage({
    id: 'stage-media',
    seq: 2,
    kind: 'media',
    status: 'queued',
    phase: null,
    processed: 0,
    total: null,
    weight: 30,
    durationMs: null,
    startedAt: null,
    finishedAt: null,
  }),
  stage({
    id: 'stage-push',
    seq: 3,
    kind: 'push',
    status: 'queued',
    phase: null,
    processed: 0,
    total: null,
    weight: 15,
    durationMs: null,
    startedAt: null,
    finishedAt: null,
  }),
];

describe('buildActiveSnapshot', () => {
  it('names a run by the archive it is importing, not the batch label', () => {
    const snapshot = buildActiveSnapshot({
      runs: [run()],
      stages: TAKEOUT_STAGES,
      // The staged source is an inbox DIRECTORY, so the path is the name.
      units: new Map([['run-takeout', '/srv/import/inbox/google-takeout']]),
      records: new Map(),
      now: NOW,
    });

    // The one addition that makes thirteen identical rows legible.
    expect(snapshot.runs[0].unit).toBe('google-takeout');
    expect(snapshot.runs[0].label).toBe('qa-full-corpus');
  });

  it('falls back to what the unpack stage recorded when the staged source is gone', () => {
    const snapshot = buildActiveSnapshot({
      runs: [run()],
      stages: [stage({ detail: { filename: 'google-takeout' } }), ...TAKEOUT_STAGES.slice(1)],
      units: new Map(),
      records: new Map(),
      now: NOW,
    });

    expect(snapshot.runs[0].unit).toBe('google-takeout');
  });

  it('separates a stage waiting for the slot from one its own run has not reached', () => {
    const snapshot = buildActiveSnapshot({
      runs: [run()],
      stages: TAKEOUT_STAGES,
      units: new Map([['run-takeout', 'google-takeout']]),
      records: new Map(),
      now: NOW,
    });

    const [unpack, parse, media, push] = snapshot.runs[0].stages;

    expect(unpack.queueState).toBe('done');
    expect(parse.queueState).toBe('done');
    // Every earlier stage is terminal, so `enqueueStage` has been called for it
    // and it is genuinely sitting in the queue.
    expect(media.queueState).toBe('waiting');
    // Its own run has not got here — nothing is waiting on it yet. Identical
    // `status: 'queued'` in the database; entirely different situations.
    expect(push.queueState).toBe('blocked');
    expect(media.status).toBe(push.status);
  });

  it('dates the wait from when the previous stage finished, and reports how long', () => {
    const snapshot = buildActiveSnapshot({
      runs: [run()],
      stages: TAKEOUT_STAGES,
      units: new Map(),
      records: new Map(),
      now: NOW,
    });

    const media = snapshot.runs[0].stages[2];

    // Parse finished at 01:04:06; that instant is when the media stage was
    // enqueued (checked against `pgboss.job.created_on` on the live queue,
    // which matched to within ~50ms).
    expect(media.waitingSince).toBe('2026-08-19T01:04:06.000Z');
    expect(media.elapsedMs).toBe(19 * 60_000 + 54_000);

    // A blocked stage is NOT waiting on the queue, so it reports no wait —
    // showing the run's elapsed time here would read as "stuck for an hour".
    expect(snapshot.runs[0].stages[3].waitingSince).toBeNull();
    expect(snapshot.runs[0].stages[3].elapsedMs).toBeNull();
  });

  it("ranks each KIND's ready queue by when its stages became runnable", () => {
    // Three runs whose parse finished at 01:04, 01:05 and 01:13 — the order
    // their slots will take them in. One queue per kind, so the media stage is
    // first among media and the two pushes are first and second among pushes:
    // ranking them in one line would tell the media stage it is third when it
    // is next, which is the sort of confident wrong number this endpoint is
    // meant to end.
    const runs = [
      run({ id: 'run-takeout', createdAt: new Date('2026-08-19T00:17:59Z') }),
      run({ id: 'run-instagram', createdAt: new Date('2026-08-19T00:18:00Z') }),
      run({ id: 'run-spotify', createdAt: new Date('2026-08-19T00:18:01Z') }),
    ];
    const stages = [
      ...TAKEOUT_STAGES,
      stage({
        id: 'insta-parse',
        runId: 'run-instagram',
        seq: 0,
        kind: 'parse',
        finishedAt: new Date('2026-08-19T01:04:16Z'),
      }),
      stage({
        id: 'insta-push',
        runId: 'run-instagram',
        seq: 1,
        kind: 'push',
        status: 'queued',
        durationMs: null,
        startedAt: null,
        finishedAt: null,
      }),
      stage({
        id: 'spotify-parse',
        runId: 'run-spotify',
        seq: 0,
        kind: 'parse',
        finishedAt: new Date('2026-08-19T01:13:34Z'),
      }),
      stage({
        id: 'spotify-push',
        runId: 'run-spotify',
        seq: 1,
        kind: 'push',
        status: 'queued',
        durationMs: null,
        startedAt: null,
        finishedAt: null,
      }),
    ];

    const snapshot = buildActiveSnapshot({ runs, stages, units: new Map(), records: new Map(), now: NOW });
    const positions = snapshot.runs.flatMap((entry) =>
      entry.stages.filter((s) => s.queuePosition != null).map((s) => [s.id, s.queuePosition] as const),
    );

    expect(positions).toEqual([
      ['stage-media', 1],
      ['insta-push', 1],
      ['spotify-push', 2],
    ]);

    // The backlog, and the numbers that say whether it is normal or wrong.
    expect(snapshot.queue.waiting).toBe(3);
    expect(snapshot.queue.blocked).toBe(1);
    // Per kind, from the appliance's own constants — `media` has two slots and
    // the rest one, and a surface claiming "one at a time" would be wrong.
    expect(snapshot.queue.concurrency).toEqual({ unpack: 1, parse: 1, media: 2, push: 1 });
    expect(snapshot.queue.slots).toBe(5);
    expect(snapshot.queue.longestWaitMs).toBe(19 * 60_000 + 54_000);
  });

  it('reports live elapsed for a stage still running, where durationMs is still null', () => {
    const snapshot = buildActiveSnapshot({
      runs: [run({ id: 'run-apple' })],
      stages: [
        stage({
          id: 'apple-push',
          runId: 'run-apple',
          seq: 0,
          kind: 'push',
          status: 'running',
          phase: 'resolving people',
          processed: 0,
          total: null,
          // Written only on finish — which is exactly why a stage in its 4th
          // minute reported nothing before this.
          durationMs: null,
          startedAt: new Date('2026-08-19T01:20:14Z'),
          finishedAt: null,
        }),
      ],
      units: new Map(),
      records: new Map(),
      now: NOW,
    });

    const push = snapshot.runs[0].stages[0];

    expect(push.queueState).toBe('running');
    expect(push.elapsedMs).toBe(3 * 60_000 + 46_000);
    expect(snapshot.queue.running).toBe(1);
  });

  /**
   * The reproduction this flag exists for: a worker restarted mid-parse left
   * the stage `running`, `processed` frozen at 8141, no error — and every
   * surface went on calling it running. `updatedAt` is the claim's heartbeat,
   * so its silence is the tell.
   */
  it('flags a running stage whose heartbeat has gone silent as stalled', () => {
    const parse = (overrides: Partial<ImportStage>) =>
      stage({
        id: 'takeout-parse',
        runId: 'run-takeout',
        seq: 1,
        kind: 'parse',
        status: 'running',
        phase: 'parsing google_activity (3/56)',
        processed: 8141,
        total: null,
        durationMs: null,
        startedAt: new Date('2026-08-19T00:30:00Z'),
        finishedAt: null,
        ...overrides,
      });

    const silent = buildActiveSnapshot({
      runs: [run()],
      stages: [stage(), parse({ updatedAt: new Date(NOW.getTime() - 4 * 60_000) })],
      units: new Map(),
      records: new Map(),
      now: NOW,
    });
    const stalled = silent.runs[0].stages[1];

    // Still RUNNING — it holds its slot, and says so — and stalled beside it.
    expect(stalled.queueState).toBe('running');
    expect(stalled.stalled).toBe(true);
    expect(stalled.heartbeatAt).toBe('2026-08-19T01:20:00.000Z');
    expect(silent.runs[0].stalled).toBe(true);
    expect(silent.queue.stalled).toBe(1);

    // Two missed beats is a slow parse, not a stalled one.
    const beating = buildActiveSnapshot({
      runs: [run()],
      stages: [stage(), parse({ updatedAt: new Date(NOW.getTime() - 60_000) })],
      units: new Map(),
      records: new Map(),
      now: NOW,
    });

    expect(beating.runs[0].stages[1].stalled).toBe(false);
    expect(beating.runs[0].stalled).toBe(false);
    expect(beating.queue.stalled).toBe(0);
  });

  it('never calls a stage that is not running stalled, however old its row', () => {
    // A finished stage, or one waiting in line, is not supposed to beat.
    const snapshot = buildActiveSnapshot({
      runs: [run()],
      stages: [
        stage({ updatedAt: new Date('2026-08-19T00:18:19Z') }),
        stage({
          id: 'takeout-parse',
          seq: 1,
          kind: 'parse',
          status: 'queued',
          processed: 0,
          durationMs: null,
          startedAt: null,
          finishedAt: null,
          updatedAt: new Date('2026-08-19T00:18:19Z'),
        }),
      ],
      units: new Map(),
      records: new Map(),
      now: NOW,
    });

    expect(snapshot.runs[0].stages.map((entry) => entry.stalled)).toEqual([false, false]);
    expect(snapshot.queue.stalled).toBe(0);
  });

  it('carries a failed stage error and counts the failure in the batch', () => {
    const snapshot = buildActiveSnapshot({
      runs: [
        run({ id: 'run-ok' }),
        run({
          id: 'run-bad',
          status: 'failed',
          percent: 55,
          error: 'ENOSPC: no space left on device',
          finishedAt: new Date('2026-08-19T01:10:00Z'),
        }),
      ],
      stages: [
        ...TAKEOUT_STAGES.map((s) => ({ ...s, runId: 'run-ok' }) as ImportStage),
        stage({
          id: 'bad-push',
          runId: 'run-bad',
          seq: 0,
          kind: 'push',
          status: 'failed',
          error: 'ENOSPC: no space left on device',
          finishedAt: new Date('2026-08-19T01:10:00Z'),
        }),
      ],
      units: new Map([['run-bad', 'facebook']]),
      records: new Map(),
      now: NOW,
    });

    const bad = snapshot.runs.find((entry) => entry.id === 'run-bad');

    expect(bad?.unit).toBe('facebook');
    expect(bad?.stages[0].error).toBe('ENOSPC: no space left on device');
    expect(bad?.stages[0].queueState).toBe('done');
    expect(snapshot.batch.failed).toBe(1);
    // Still active: one run failing does not end the batch, and the header must
    // not go quiet while twelve others are still importing.
    expect(snapshot.active).toBe(true);
  });

  it('keeps finished runs in the batch so the counter does not eat its own denominator', () => {
    const snapshot = buildActiveSnapshot({
      runs: [
        run({
          id: 'run-amazon',
          status: 'completed',
          percent: 100,
          finishedAt: new Date('2026-08-19T00:18:31Z'),
        }),
        run({ id: 'run-takeout' }),
      ],
      stages: TAKEOUT_STAGES,
      units: new Map([
        ['run-amazon', 'amazon'],
        ['run-takeout', 'google-takeout'],
      ]),
      records: new Map([['run-amazon', 2_777]]),
      now: NOW,
    });

    expect(snapshot.batch.total).toBe(2);
    expect(snapshot.batch.completed).toBe(1);
    expect(snapshot.batch.running).toBe(1);
    expect(snapshot.batch.records).toBe(2_777);
    expect(snapshot.active).toBe(true);
    // Execution order, oldest first — under one slot that is also finish order.
    expect(snapshot.runs.map((entry) => entry.unit)).toEqual(['amazon', 'google-takeout']);
  });

  it("collapses a Takeout's 47 recognized files to one entry per service", () => {
    const snapshot = buildActiveSnapshot({
      runs: [
        run({
          dataSources: [
            'google_voice',
            'google_my_activity',
            'google_my_activity',
            'calendar',
            'google_my_activity',
            'vcard',
            'calendar',
          ],
        }),
      ],
      stages: TAKEOUT_STAGES,
      units: new Map(),
      records: new Map(),
      now: NOW,
    });

    // Most-frequent first: the dominant source is what the archive mostly is.
    expect(snapshot.runs[0].dataSources).toEqual(['google_my_activity', 'calendar', 'google_voice', 'vcard']);
  });

  it('goes quiet — active false, nothing to render — when every run has finished', () => {
    const snapshot = buildActiveSnapshot({
      runs: [run({ status: 'completed', percent: 100, finishedAt: new Date('2026-08-19T01:20:00Z') })],
      stages: TAKEOUT_STAGES.map((s) => ({ ...s, status: 'completed' }) as ImportStage),
      units: new Map(),
      records: new Map(),
      now: NOW,
    });

    expect(snapshot.active).toBe(false);
    expect(snapshot.queue.waiting).toBe(0);
  });

  it('idleSnapshot is the shape a caller renders as nothing', () => {
    const snapshot = idleSnapshot(NOW);

    expect(snapshot.active).toBe(false);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.batch.total).toBe(0);
    expect(snapshot.queue.concurrency).toEqual({ unpack: 1, parse: 1, media: 2, push: 1 });
  });
});

describe('classifyStages', () => {
  it('marks at most one stage per run as waiting, whatever the ladder looks like', () => {
    // Three queued stages behind a running one: only the running one holds the
    // slot, and NONE of the three is enqueued — `enqueueStage` fires once, as
    // each stage finishes.
    const states = classifyStages(
      { startedAt: new Date('2026-08-19T00:18:17Z'), createdAt: new Date('2026-08-19T00:17:59Z') },
      [
        stage({ seq: 0, status: 'completed' }),
        stage({ seq: 1, status: 'running', finishedAt: null }),
        stage({ seq: 2, status: 'queued', finishedAt: null }),
        stage({ seq: 3, status: 'queued', finishedAt: null }),
      ],
    ).map((entry) => entry.state);

    expect(states).toEqual(['done', 'running', 'blocked', 'blocked']);
  });

  it('treats a skipped stage as passed, so the next one is genuinely waiting', () => {
    // A run with no media skips that stage in a beat. Its successor must not be
    // reported as blocked forever behind a stage that will never run again.
    const states = classifyStages(
      { startedAt: new Date('2026-08-19T00:18:17Z'), createdAt: new Date('2026-08-19T00:17:59Z') },
      [
        stage({ seq: 0, status: 'completed' }),
        stage({ seq: 1, status: 'skipped' }),
        stage({ seq: 2, status: 'queued', finishedAt: null }),
      ],
    ).map((entry) => entry.state);

    expect(states).toEqual(['done', 'done', 'waiting']);
  });

  it('never calls a stage of a FINISHED run "waiting" — nothing will ever run it', () => {
    // Seen on screen: a failed run whose remaining `queued` row rendered as
    // "Next in the save queue". When a stage fails the run is finished without
    // its successor being enqueued, so that row is abandoned, not queued — and
    // counting it inflates the backlog with a job that does not exist.
    const states = classifyStages(
      {
        startedAt: new Date('2026-08-19T00:18:17Z'),
        createdAt: new Date('2026-08-19T00:17:59Z'),
        status: 'failed',
        finishedAt: new Date('2026-08-19T00:22:00Z'),
      },
      [
        stage({ seq: 0, status: 'completed' }),
        stage({ seq: 1, status: 'failed', error: 'ENOSPC' }),
        stage({ seq: 2, status: 'queued', startedAt: null, finishedAt: null }),
      ],
    ).map((entry) => entry.state);

    expect(states).toEqual(['done', 'done', 'blocked']);
  });

  it("dates a first stage's wait from the run itself, since nothing precedes it", () => {
    const [first] = classifyStages({ startedAt: null, createdAt: new Date('2026-08-19T00:17:59Z') }, [
      stage({ seq: 0, status: 'queued', startedAt: null, finishedAt: null }),
    ]);

    expect(first.state).toBe('waiting');
    expect(first.readyAt).toEqual(new Date('2026-08-19T00:17:59Z'));
  });
});
