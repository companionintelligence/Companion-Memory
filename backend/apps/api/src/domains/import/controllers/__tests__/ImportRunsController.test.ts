import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';

import { ImportRunsController } from '../ImportRunsController';

/**
 * The run surface a person watches while their export imports.
 *
 * What is worth pinning here is the shape the UI depends on and the guards that
 * stop a caller reaching past their own runs:
 *
 *  - a stage with no countable total reports `null`, not 0 — a 0/0 bar reads as
 *    a finished stage;
 *  - an unknown stage name is refused BEFORE the run starts, where the caller
 *    can still fix it, rather than failing mid-import;
 *  - only a failed or cancelled stage can be re-run, because re-running a
 *    completed one would redo work that already landed in ci.*;
 *  - another user's run is a 404, not someone else's data.
 */

const ctx = { userId: 'user-1' } as RequestContext;

const RUN = {
  id: 'run-1',
  label: 'Takeout.zip',
  source: 'wizard',
  dataSources: ['audible', 'amazon'],
  status: 'running',
  percent: 30,
  requestedStages: ['unpack', 'parse', 'push'],
  error: null,
  createdAt: new Date('2026-08-12T00:00:00Z'),
  startedAt: new Date('2026-08-12T00:01:00Z'),
  finishedAt: null,
};

const STAGES = [
  {
    id: 'stage-unpack',
    seq: 0,
    kind: 'unpack',
    status: 'completed',
    phase: 'expanded',
    processed: '1',
    total: '1',
    weight: 30,
    itemsPerSec: null,
    etaSeconds: null,
    durationMs: '1200',
    error: null,
    detail: {},
    startedAt: new Date('2026-08-12T00:01:00Z'),
    finishedAt: new Date('2026-08-12T00:01:01Z'),
  },
  {
    id: 'stage-parse',
    seq: 1,
    kind: 'parse',
    status: 'running',
    phase: 'parsing gmail (1/2)',
    processed: '412',
    // A parse discovers its total, so until it does there is nothing to divide by.
    total: null,
    weight: 50,
    // Measured throughput, recorded since the table was created and dropped by
    // the mapper until now.
    itemsPerSec: 554.94,
    etaSeconds: null,
    durationMs: null,
    error: null,
    detail: { recognized: ['gmail', 'google_photos'] },
    startedAt: new Date('2026-08-12T00:01:01Z'),
    finishedAt: null,
  },
];

function makeController(
  overrides: {
    detail?: { run: typeof RUN; stages: typeof STAGES } | null;
    cancel?: boolean;
    retry?: boolean;
    batch?: null;
    discarded?: null;
    retryFailedPush?: { items: number; entities: number; requeued: boolean } | null;
  } = {},
) {
  const runs = {
    // Typed generically rather than with unused parameters: the assertions read
    // `mock.calls[0][1]`, which needs a two-argument signature to index.
    startRun: jest.fn<Promise<{ run: typeof RUN; stages: typeof STAGES }>, [unknown, { stages?: string[] }]>(
      async () => ({ run: RUN, stages: STAGES }),
    ),
    listRuns: jest.fn(async () => [RUN]),
    getRunDetail: jest.fn(async () =>
      overrides.detail === undefined ? { run: RUN, stages: STAGES } : overrides.detail,
    ),
    listUnpushed: jest.fn(async () => [{ run: RUN, pendingItems: 3, pendingEntities: 1 }]),
    startPush: jest.fn<
      Promise<Array<{ run: typeof RUN; stage: (typeof STAGES)[number] }>>,
      [unknown, { runIds?: readonly string[] }]
    >(async () => [{ run: RUN, stage: STAGES[0] }]),
    cancel: jest.fn(async () => overrides.cancel ?? true),
    retryStage: jest.fn(async () => overrides.retry ?? true),
    retryFailedPush: jest.fn(
      async (): Promise<{ items: number; entities: number; requeued: boolean } | null> =>
        overrides.retryFailedPush === undefined
          ? { items: 437, entities: 0, requeued: true }
          : overrides.retryFailedPush,
    ),
    activeBatch: jest.fn(async () =>
      overrides.batch === undefined
        ? {
            runs: [{ ...RUN, userId: 'user-1', updatedAt: RUN.createdAt }],
            stages: STAGES.map((stage) => ({ ...stage, runId: RUN.id })),
            units: new Map([[RUN.id, '/srv/import/inbox/google-takeout']]),
            records: new Map([[RUN.id, 2_777]]),
            truncated: false,
          }
        : overrides.batch,
    ),
  };

  const catalog = {
    list: jest.fn(() => [{ name: 'gmail', title: 'Gmail', stub: false }]),
    catalog: jest.fn(() => [
      { id: 'gmail', title: 'Gmail (Google Takeout)', importer: 'gmail', importerReady: true },
    ]),
    find: jest.fn((name: string) => (name === 'gmail' ? { name, title: 'Gmail' } : null)),
  };

  const users = {
    findById: jest.fn(async () => ({ id: 'user-1', email: 'tester@example.com' })),
  };

  const retention = {
    discardRun: jest.fn(async () =>
      overrides.discarded === undefined
        ? {
            runId: RUN.id,
            label: RUN.label,
            stagedRowsDeleted: 1_201,
            sourceRowsDeleted: 1,
            uploadsRestaged: 0,
            mediaFilesKept: 412,
            attachmentContentsKept: 0,
          }
        : overrides.discarded,
    ),
  };

  const objectCounts = {
    countsForUser: jest.fn(async () => [{ importer: 'gmail', label: 'Mail', count: 42 }]),
  };

  return {
    controller: new ImportRunsController(
      runs as never,
      catalog as never,
      retention as never,
      users as never,
      objectCounts as never,
    ),
    runs,
    catalog,
    retention,
    users,
    objectCounts,
  };
}

describe('ImportRunsController.start', () => {
  beforeEach(() => jest.clearAllMocks());

  it('starts a run against a staged upload and returns its stage bar', async () => {
    const { controller, runs } = makeController();

    const detail = await controller.start(ctx, { dropId: 'drop-1' });

    expect(runs.startRun).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        dropId: 'drop-1',
        source: 'api',
      }),
    );
    expect(detail.stages.map((stage) => stage.kind)).toEqual(['unpack', 'parse']);
  });

  it('requires a drop to import', async () => {
    const { controller } = makeController();

    await expect(controller.start(ctx, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an unknown stage name before the run starts', async () => {
    // A typo would otherwise create a stage no runner can execute, which fails
    // loudly but only after the import is under way.
    const { controller, runs } = makeController();

    await expect(controller.start(ctx, { dropId: 'drop-1', stages: ['unpack', 'unpakc'] })).rejects.toThrow(
      /unpakc/,
    );
    expect(runs.startRun).not.toHaveBeenCalled();
  });

  it('accepts a narrowed stage list, which is how "just unpack it" is expressed', async () => {
    const { controller, runs } = makeController();

    await controller.start(ctx, { dropId: 'drop-1', stages: ['unpack'] });

    expect(runs.startRun.mock.calls[0][1]).toMatchObject({ stages: ['unpack'] });
  });
});

describe('ImportRunsController.get', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports an uncountable stage total as null rather than zero', async () => {
    const { controller } = makeController();

    const detail = await controller.get(ctx, 'run-1');

    // 0/0 would render as a finished stage; null is what tells the UI to draw an
    // indeterminate bar.
    expect(detail.stages[1].total).toBeNull();
    // bigint columns arrive as strings and must not reach the client that way.
    expect(detail.stages[1].processed).toBe(412);
    expect(detail.stages[0].durationMs).toBe(1200);
  });

  it('carries the detected services through to the run list', async () => {
    // The summary is built field by field, so a column added to the run does not
    // reach the page on its own — and the list has nothing but the archive's
    // filename to name a run with otherwise.
    const { controller } = makeController();
    const [listed] = await controller.list(ctx);

    expect(listed.dataSources).toEqual(['audible', 'amazon']);
  });

  it('404s a run this user does not have', async () => {
    const { controller } = makeController({ detail: null });

    await expect(controller.get(ctx, 'someone-elses-run')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ImportRunsController.recognized', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports what the parse found, resolved against the catalog', async () => {
    const { controller } = makeController();

    const answer = await controller.recognized(ctx, 'run-1');

    // google_photos is not in this catalog double, so it drops out rather than
    // being returned as a bare name the UI cannot render.
    expect(answer.recognized.map((source) => source.name)).toEqual(['gmail']);
  });

  it('says pending while the parse is still running', async () => {
    // An empty list before the parse means UNKNOWN, not "nothing in your
    // archive" — a caller that cannot tell those apart shows the wrong thing.
    const { controller } = makeController();

    expect((await controller.recognized(ctx, 'run-1')).pending).toBe(true);
  });

  it('says settled once the parse has finished', async () => {
    const { controller } = makeController({
      detail: {
        run: RUN,
        stages: [{ ...STAGES[1], status: 'completed' }],
      },
    });

    expect((await controller.recognized(ctx, 'run-1')).pending).toBe(false);
  });
});

describe('ImportRunsController.cancel and retry', () => {
  beforeEach(() => jest.clearAllMocks());

  it('cancels a run in flight', async () => {
    const { controller } = makeController();

    expect(await controller.cancel(ctx, 'run-1')).toEqual({ cancelled: true });
  });

  it('404s a run that is already finished', async () => {
    const { controller } = makeController({ cancel: false });

    await expect(controller.cancel(ctx, 'run-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('re-queues a failed stage', async () => {
    const { controller, runs } = makeController();

    expect(await controller.retryStage(ctx, 'run-1', 'stage-parse')).toEqual({ requeued: true });
    expect(runs.retryStage).toHaveBeenCalledWith({ userId: 'user-1' }, 'run-1', 'stage-parse');
  });

  it('refuses to re-run a stage that did not fail', async () => {
    // Re-running a completed stage would redo work already in ci.*.
    const { controller } = makeController({ retry: false });

    await expect(controller.retryStage(ctx, 'run-1', 'stage-unpack')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

/**
 * The operator's way back for rows a push could not write — `ci push --run <id>
 * --retry-failed`. What may be retried is the service's rule (and is asserted
 * against real Postgres in `failedPushRecovery.integration.spec.ts`); the edge
 * owes the caller the counts, a 404 for a run that is not theirs, and the
 * service's 409 unchanged, since its message names the stage still working.
 */
describe('ImportRunsController.retryFailedPush', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports how many rows went back to the queue, for the caller only', async () => {
    const { controller, runs } = makeController();

    expect(await controller.retryFailedPush(ctx, 'run-1')).toEqual({
      items: 437,
      entities: 0,
      requeued: true,
    });
    expect(runs.retryFailedPush).toHaveBeenCalledWith({ userId: 'user-1' }, 'run-1');
  });

  it('answers nothing-stranded with zero counts, not an error', async () => {
    const { controller } = makeController({ retryFailedPush: { items: 0, entities: 0, requeued: false } });

    expect(await controller.retryFailedPush(ctx, 'run-1')).toEqual({
      items: 0,
      entities: 0,
      requeued: false,
    });
  });

  it('404s a run that is not this user’s', async () => {
    const { controller } = makeController({ retryFailedPush: null });

    await expect(controller.retryFailedPush(ctx, 'run-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('passes the refusal for a run still pushing through as a 409', async () => {
    const { controller, runs } = makeController();

    runs.retryFailedPush.mockRejectedValueOnce(
      new ConflictException('Import run run-1 is still pushing (its push stage is running).'),
    );

    await expect(controller.retryFailedPush(ctx, 'run-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses an unauthenticated caller before touching the service', async () => {
    const { controller, runs } = makeController();

    await expect(controller.retryFailedPush({} as RequestContext, 'run-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(runs.retryFailedPush).not.toHaveBeenCalled();
  });
});

/**
 * The one route on this controller that destroys data with no undo.
 *
 * The guards worth pinning at the edge are the two the service cannot make:
 * a DELETE must not fire without the caller having said so in as many words,
 * and a run that is not the caller's must be a 404 rather than a silent
 * success. What MAY be discarded is the service's rule and is asserted against
 * real Postgres in `importRetention.integration.spec.ts`.
 */
describe('ImportRunsController.discard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('refuses to delete anything without an explicit confirmation', async () => {
    const { controller, retention } = makeController();

    await expect(controller.discard(ctx, 'run-1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.discard(ctx, 'run-1', 'yes')).rejects.toBeInstanceOf(BadRequestException);
    expect(retention.discardRun).not.toHaveBeenCalled();
  });

  it('discards a confirmed run and reports exactly what went', async () => {
    const { controller, retention } = makeController();

    expect(await controller.discard(ctx, 'run-1', 'discard')).toEqual({
      runId: 'run-1',
      label: 'Takeout.zip',
      stagedRowsDeleted: 1_201,
      sourceRowsDeleted: 1,
      uploadsRestaged: 0,
      // Passed through untouched, including the survivals. The route must not
      // summarise a destructive reply down to what it took.
      mediaFilesKept: 412,
      attachmentContentsKept: 0,
    });
    expect(retention.discardRun).toHaveBeenCalledWith({ userId: 'user-1' }, 'run-1');
  });

  it('404s a run that is not this user’s', async () => {
    const { controller } = makeController({ discarded: null });

    await expect(controller.discard(ctx, 'someone-elses-run', 'discard')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ImportRunsController.listSources', () => {
  it('lists what this appliance can import', () => {
    const { controller } = makeController();

    expect(controller.listSources()).toEqual([{ name: 'gmail', title: 'Gmail', stub: false }]);
  });
});

describe('ImportRunsController.sourceCatalog', () => {
  it('serves the source-keyed projection verbatim', () => {
    // Order and content are the service's; re-shaping either here would undo
    // the curated tier-then-ecosystem ordering the wizard renders.
    const { controller, catalog } = makeController();

    expect(controller.sourceCatalog()).toBe(catalog.catalog.mock.results[0].value);
  });
});

describe('ImportRunsController.objectCountsForCaller', () => {
  it('asks the service for the CALLER only, never a bare list-everything', () => {
    const { controller, objectCounts } = makeController();

    void controller.objectCountsForCaller(ctx);

    expect(objectCounts.countsForUser).toHaveBeenCalledWith('user-1');
  });

  it('serves the service result verbatim', async () => {
    const { controller } = makeController();

    await expect(controller.objectCountsForCaller(ctx)).resolves.toEqual([
      { importer: 'gmail', label: 'Mail', count: 42 },
    ]);
  });

  it('refuses an unauthenticated caller before touching the database', async () => {
    const { controller, objectCounts } = makeController();

    await expect(controller.objectCountsForCaller({} as RequestContext)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(objectCounts.countsForUser).not.toHaveBeenCalled();
  });
});

describe('ImportRunsController.listUnpushed', () => {
  beforeEach(() => jest.clearAllMocks());

  it('maps each eligible run to its summary plus the pending counts', async () => {
    const { controller } = makeController();

    const unpushed = await controller.listUnpushed(ctx);

    expect(unpushed).toHaveLength(1);
    expect(unpushed[0]).toMatchObject({
      id: 'run-1',
      status: 'running',
      pendingItems: 3,
      pendingEntities: 1,
    });
    // The same field-by-field mapper as every other run answer — a new column
    // does not reach the wire unless it joins toRunSummary.
    expect(unpushed[0].createdAt).toEqual(RUN.createdAt);
  });

  it('refuses an unauthenticated caller', async () => {
    const { controller, runs } = makeController();

    await expect(controller.listUnpushed({} as RequestContext)).rejects.toBeInstanceOf(BadRequestException);
    expect(runs.listUnpushed).not.toHaveBeenCalled();
  });
});

describe('ImportRunsController.startPush', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pushes everything when no body is sent — the Sync button’s call', async () => {
    const { controller, runs } = makeController();

    const result = await controller.startPush(ctx, undefined);

    expect(runs.startPush).toHaveBeenCalledWith({ userId: 'user-1' }, { runIds: undefined });
    expect(result.runs.map((run) => run.id)).toEqual(['run-1']);
  });

  it('passes a run-id filter through', async () => {
    const { controller, runs } = makeController();
    const id = 'a81bc81b-dead-4e5d-abff-90865d1e13b1';

    await controller.startPush(ctx, { runIds: [id] });

    expect(runs.startPush.mock.calls[0][1]).toEqual({ runIds: [id] });
  });

  it('refuses a malformed run id before the service is called', async () => {
    // The service binds these to a ::uuid[] cast, where a typo becomes a
    // Postgres syntax error — a 500 wearing the wrong blame.
    const { controller, runs } = makeController();

    await expect(controller.startPush(ctx, { runIds: ['not-a-uuid'] })).rejects.toThrow(/not-a-uuid/);
    expect(runs.startPush).not.toHaveBeenCalled();
  });

  it('answers nothing-to-sync with an empty list, not an error', async () => {
    const { controller, runs } = makeController();

    runs.startPush.mockResolvedValueOnce([]);

    expect(await controller.startPush(ctx, undefined)).toEqual({ runs: [] });
  });
});

describe('ImportRunsController authentication', () => {
  it('refuses an unauthenticated caller rather than reading another user', async () => {
    const { controller, runs } = makeController();

    await expect(controller.list({} as RequestContext)).rejects.toBeInstanceOf(BadRequestException);
    expect(runs.listRuns).not.toHaveBeenCalled();
  });
});

/**
 * The one URL to poll while an import runs — and the one to curl when an import
 * looks wrong.
 *
 * It exists because per-run detail polling does not survive contact with a batch
 * import: an inbox scan starts one run per top-level folder, so the 13-source
 * corpus this was written against meant 13 requests every two seconds and still
 * no answer to "why has that one not moved in an hour?".
 */
describe('ImportRunsController.active', () => {
  beforeEach(() => jest.clearAllMocks());

  it('answers with a rendered-as-nothing snapshot rather than a 404 when nothing is importing', async () => {
    // "Nothing is importing" is a state every caller renders by rendering
    // nothing. An error here would put a banner on a page whose only sin is
    // that the import already finished.
    const { controller } = makeController({ batch: null });

    const snapshot = await controller.active(ctx);

    expect(snapshot.active).toBe(false);
    expect(snapshot.runs).toEqual([]);
  });

  it('names each run by its unit and states the queue it is contending for', async () => {
    const { controller } = makeController();

    const snapshot = await controller.active(ctx);

    expect(snapshot.active).toBe(true);
    expect(snapshot.runs[0].unit).toBe('google-takeout');
    expect(snapshot.runs[0].records).toBe(2_777);
    // The numbers that make a long queue legible instead of alarming — per
    // kind, because that is how the appliance queues stages.
    expect(snapshot.queue.concurrency.parse).toBe(1);
    expect(snapshot.queue.slots).toBeGreaterThan(0);
  });

  it('scopes itself to the caller, like every other run route here', async () => {
    const { controller, runs } = makeController();

    await controller.active(ctx);

    expect(runs.activeBatch).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('requires an authenticated user', async () => {
    const { controller } = makeController();

    await expect(controller.active({} as RequestContext)).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * Three columns the stage mapper used to drop on the floor.
 *
 * `items_per_sec`, `started_at` and `finished_at` have been written since the
 * table was created, and no surface could show any of them — so "is that parse
 * slow or is it big?" and "how long has this been going?" had no answer short of
 * a psql session, on a stage that had been running for 46 minutes.
 */
describe('ImportRunsController stage mapping', () => {
  beforeEach(() => jest.clearAllMocks());

  it('carries throughput and timestamps through to the client', async () => {
    const { controller } = makeController();

    const detail = await controller.get(ctx, 'run-1');
    const parse = detail.stages[1];

    expect(parse.itemsPerSec).toBe(554.94);
    expect(parse.startedAt).toEqual(new Date('2026-08-12T00:01:01Z'));
    // A stage still running has no duration yet — which is exactly why the
    // start time has to travel.
    expect(parse.durationMs).toBeNull();
    expect(parse.finishedAt).toBeNull();
  });
});

/**
 * The declaration-order trap, guarded.
 *
 * `runs/active` and `runs/unpushed` are literal paths that must be declared
 * ABOVE `runs/:runId`. Express matches in declaration order, so below it both
 * resolve as a run id named "active"/"unpushed" — the endpoint keeps existing
 * and silently stops working. The controller says so in a comment on each; a
 * comment does not fail a build, and reordering methods is exactly the kind of
 * tidy-up that looks harmless in review.
 *
 * Asserted off the Nest route metadata rather than by booting an HTTP app: the
 * ordering IS the metadata, and reading it keeps this a unit test.
 */
describe('ImportRunsController route declaration order', () => {
  const pathsInOrder = (): string[] => {
    const proto = ImportRunsController.prototype as unknown as Record<string, unknown>;

    return Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .map((name) => Reflect.getMetadata('path', proto[name] as object) as string | undefined)
      .filter((path): path is string => typeof path === 'string');
  };

  it.each([['runs/active'], ['runs/unpushed']])('declares %s before the runs/:runId catch-all', (literal) => {
    const paths = pathsInOrder();
    const literalAt = paths.indexOf(literal);
    const paramAt = paths.indexOf('runs/:runId');

    expect(literalAt).toBeGreaterThanOrEqual(0);
    expect(paramAt).toBeGreaterThanOrEqual(0);
    expect(literalAt).toBeLessThan(paramAt);
  });
});
