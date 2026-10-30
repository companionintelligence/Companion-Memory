import path from 'node:path';

import type { DataSourceRecognition } from '../../datasources/registry';
import { MEDIA_STORE_DIRNAME } from '../../datasources/timeline';
import { SUMMARY_KEY, type StageSummary } from '../../telemetry/stageSummary';
import type { StageRunContext } from '../../types';
import { ParseStage } from '../ParseStage';

/**
 * The central orchestration `run()` does: recognize, run each recognized
 * parser, catch a failing one and continue with the rest, and end the run
 * `partial` rather than `failed` when one did. The class's own doc comment
 * calls this out as the central design property ("One bad parser does not
 * fail the import") — a Takeout where one parser chokes still lands the other
 * five, rather than teaching people to re-upload 40GB because one parser met
 * a file it disliked. Only the two pure helpers this delegates to
 * (`dropGenericWhenSpecialised`, `rankDataSources`) had direct coverage before
 * this file; nothing drove `run()` itself.
 *
 * Recognition and staging are mocked at their module boundaries — which
 * source claims which tree is the parsers' own business (covered where they
 * are tested), and `StagedWriter`'s DB writes are covered by the staging
 * integration specs. What is under test here is `run()`'s own control flow.
 */

jest.mock('../../datasources/registry', () => ({
  dataSourcesRecognize: jest.fn(async () => []),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dataSourcesRecognize } = require('../../datasources/registry') as { dataSourcesRecognize: jest.Mock };

jest.mock('../../staging/StagedWriter', () => ({
  StagedWriter: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StagedWriter } = require('../../staging/StagedWriter') as { StagedWriter: jest.Mock };

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const emptyTotals = { items: 0, itemsDeduped: 0, entities: 0, entitiesGrown: 0, relationships: 0, drops: {} };

/** A recognized match whose importer either stages `items` rows or throws. */
function matchFor(name: string, opts: { throws?: string; items?: number } = {}): DataSourceRecognition {
  return {
    data_source: {
      name,
      title: name,
      icon: '',
      description: '',
      newFileImporter: () => ({
        recognize: async () => ({ confidence: 1 }),
        fileImport: async () => {
          if (opts.throws) {
            throw new Error(opts.throws);
          }
        },
      }),
    },
    recognition: { confidence: 1 },
  } as unknown as DataSourceRecognition;
}

function buildStage(totalsBySource: Record<string, typeof emptyTotals & { recordsRead?: number }> = {}) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];

  const dataSource = {
    manager: {},
    query: jest.fn(async (sql: string, params: unknown[]) => {
      updates.push({ sql, params });

      return [];
    }),
  };

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

  // One StagedWriter instance per parseOne() call. The constructor's second
  // argument carries { dataSource: name }, which is how each instance knows
  // which source's totals to answer with.
  StagedWriter.mockImplementation((_manager: unknown, opts: { dataSource: string }) => ({
    push: jest.fn(),
    settled: jest.fn(async () => undefined),
    totals: totalsBySource[opts.dataSource] ?? emptyTotals,
  }));

  return { stage: new ParseStage(dataSource as never, logger as never), dataSource, updates, logger };
}

function contextFor(): StageRunContext {
  return {
    runId: RUN_ID,
    userId: USER_ID,
    stageId: '33333333-3333-4333-8333-333333333333',
    scratchDir: '/var/tmp/ci-import/test-run',
    progress: jest.fn(async () => undefined),
  };
}

beforeEach(() => {
  dataSourcesRecognize.mockReset();
  dataSourcesRecognize.mockResolvedValue([]);
  StagedWriter.mockReset();
});

describe('ParseStage.run', () => {
  it('reports an honest "nothing recognized" outcome rather than an error', async () => {
    const { stage } = buildStage();

    const outcome = await stage.run(contextFor());

    expect(outcome).toMatchObject({ processed: 0, total: 0, partial: true });
    expect(outcome.detail).toMatchObject({ recognized: [] });
  });

  it('runs every recognized source and reports a full success', async () => {
    dataSourcesRecognize.mockResolvedValue([matchFor('gmail'), matchFor('calendar')]);
    const { stage, dataSource } = buildStage({
      gmail: { ...emptyTotals, items: 5 },
      calendar: { ...emptyTotals, items: 2 },
    });

    const outcome = await stage.run(contextFor());

    expect(outcome.partial).toBe(false);
    expect(outcome.processed).toBe(7); // 5 + 2, items + entities per source
    expect(outcome.detail.failures).toEqual([]);
    expect(outcome.detail.recognized).toEqual(['gmail', 'calendar']);

    // The run gets stamped with the ranked source list, via rankDataSources.
    const stampCall = dataSource.query.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('UPDATE ci_import.import_runs'),
    );
    expect(stampCall![1]).toEqual([RUN_ID, ['gmail', 'calendar']]);
  });

  it('lets the reconciliation check actually fail once a parser reports what it read', async () => {
    // Before any parser called `pipeline.consumed()`, `consumed` was always
    // DERIVED as `produced + dropped` — so `reconciled` could never disagree
    // with itself, and a record lost through a branch that forgot `drop()`
    // was invisible to this check by construction. A parser that reports a
    // measured `recordsRead` (spotify.ts, via StagedWriter.consumed) gives the
    // check an independent floor to compare against, and a mismatch is a real
    // finding rather than an impossible one.
    dataSourcesRecognize.mockResolvedValue([matchFor('spotify')]);
    const { stage } = buildStage({
      // 8 produced + 1 dropped = 9 accounted for, but the parser measured 12
      // records read from the file — 3 vanished through an uncounted branch.
      spotify: { ...emptyTotals, items: 8, drops: { sub_second_play: 1 }, recordsRead: 12 },
    });

    const outcome = await stage.run(contextFor());

    const summary = outcome.detail[SUMMARY_KEY] as StageSummary;

    expect(summary.reconciled).toBe(false);
    expect(summary.consumed).toBe(12);
    expect(summary.produced + summary.dropped).toBe(9);
  });

  it('catches one parser throwing, records it, and still runs the rest', async () => {
    // The central design property this stage exists for: a Takeout where one
    // of three parsers chokes lands the other two rather than aborting.
    dataSourcesRecognize.mockResolvedValue([
      matchFor('gmail'),
      matchFor('broken_source', { throws: 'unexpected end of archive' }),
      matchFor('calendar'),
    ]);
    const { stage } = buildStage({
      gmail: { ...emptyTotals, items: 3 },
      calendar: { ...emptyTotals, items: 1 },
    });

    const outcome = await stage.run(contextFor());

    // partial — terminal and success-ish — never failed. A thrown parser must
    // not abort the sources that had not run yet.
    expect(outcome.partial).toBe(true);
    expect(outcome.processed).toBe(4); // gmail's 3 + calendar's 1; broken_source staged nothing

    // The recorded failure NAMES what it was doing. A bare exception message
    // over a 13-source Takeout said nothing about which parser or which path
    // died, and the scratch tree that held the answer is reclaimed with the
    // run — see telemetry/stageError.
    const [failure] = outcome.detail.failures as Array<{ dataSource: string; error: string }>;

    expect(failure.dataSource).toBe('broken_source');
    expect(failure.error).toContain('unexpected end of archive');
    expect(failure.error).toContain('dataSource=broken_source');
    expect(failure.error).toContain('phase=parsing broken_source (2/3)');

    // Still recognized — the match happened; only the import itself failed.
    expect(outcome.detail.recognized).toEqual(['gmail', 'broken_source', 'calendar']);

    // The FAILED source is in the per-source detail too, which it was not
    // before: the throw used to skip the `perSource` push entirely, so a
    // parser that staged 300,000 rows and then met one unreadable file
    // vanished from the run's own report while its rows sat in `staged_items`.
    // Its counts are whatever its writer had reached, and its `error` says why
    // it stopped.
    expect(outcome.detail.sources).toEqual([
      { dataSource: 'gmail', ...emptyTotals, items: 3 },
      { dataSource: 'broken_source', ...emptyTotals, error: failure.error },
      { dataSource: 'calendar', ...emptyTotals, items: 1 },
    ]);
  });

  it('ends partial, not failed, even when every recognized source throws', async () => {
    // A run that staged nothing at all is still a completed (if useless) parse
    // attempt, not a hard failure — ImportRunService.pulledRecords is what
    // downstream code asks to learn whether anything landed.
    dataSourcesRecognize.mockResolvedValue([
      matchFor('a', { throws: 'boom a' }),
      matchFor('b', { throws: 'boom b' }),
    ]);
    const { stage } = buildStage();

    const outcome = await stage.run(contextFor());

    expect(outcome.partial).toBe(true);
    expect(outcome.processed).toBe(0);
    expect((outcome.detail.failures as unknown[]).length).toBe(2);
  });

  it('fails one source cleanly when its recognized match has no importer at all', async () => {
    const stubOnly: DataSourceRecognition = {
      data_source: { name: 'not_yet_implemented', title: 'Stub', icon: '', description: '', stub: true },
      recognition: { confidence: 1 },
    } as unknown as DataSourceRecognition;

    dataSourcesRecognize.mockResolvedValue([matchFor('gmail'), stubOnly]);
    const { stage } = buildStage({ gmail: { ...emptyTotals, items: 1 } });

    const outcome = await stage.run(contextFor());

    expect(outcome.partial).toBe(true);

    const [stubFailure] = outcome.detail.failures as Array<{ dataSource: string; error: string }>;

    expect(stubFailure.dataSource).toBe('not_yet_implemented');
    expect(stubFailure.error).toContain('recognized the tree but has no file importer');
    expect(stubFailure.error).toContain('dataSource=not_yet_implemented');
    expect(outcome.processed).toBe(1);
  });
});

describe('progress during one long source', () => {
  /**
   * The regression: `run()` reported progress only BETWEEN sources, so a
   * corpus dominated by one source showed a frozen counter for as long as that
   * source ran. Measured on a real Google Takeout, `processed` sat at 1,364
   * for the whole google_voice leg while the rows it was staging climbed from
   * 169,264 to 198,771 -- a live import that reads as a hung one.
   *
   * The parser here never returns until released, so every `progress` call
   * observed while it is suspended is by construction a call made DURING the
   * source, which is the property under test.
   */
  it('advances processed while a single source is still parsing', async () => {
    jest.useFakeTimers();

    try {
      let release!: () => void;
      const parsing = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Totals the writer reports grow while the parser is suspended.
      let live = { ...emptyTotals, items: 0 };

      dataSourcesRecognize.mockResolvedValue([
        {
          data_source: {
            name: 'google_voice',
            title: 'google_voice',
            icon: '',
            description: '',
            newFileImporter: () => ({
              recognize: async () => ({ confidence: 1 }),
              fileImport: async () => parsing,
            }),
          },
          recognition: { confidence: 1 },
        } as unknown as DataSourceRecognition,
      ]);

      const updates: Array<{ sql: string; params: unknown[] }> = [];
      const dataSource = {
        manager: {},
        query: jest.fn(async (sql: string, params: unknown[]) => {
          updates.push({ sql, params });

          return [];
        }),
      };
      const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

      StagedWriter.mockImplementation(() => ({
        push: jest.fn(),
        settled: jest.fn(async () => undefined),
        get totals() {
          return live;
        },
      }));

      const stage = new ParseStage(dataSource as never, logger as never);
      const context = contextFor();
      const running = stage.run(context);

      // Let run() reach the suspended fileImport and arm the sampler.
      await Promise.resolve();
      await Promise.resolve();

      const before = (context.progress as jest.Mock).mock.calls.length;

      live = { ...emptyTotals, items: 40_000 };
      await jest.advanceTimersByTimeAsync(2_000);
      live = { ...emptyTotals, items: 90_000 };
      await jest.advanceTimersByTimeAsync(2_000);

      const midRun = (context.progress as jest.Mock).mock.calls.slice(before).map((c) => c[0].processed);

      // The counter moved WHILE the source was still parsing -- the whole point.
      expect(midRun).toEqual(expect.arrayContaining([40_000, 90_000]));

      release();
      await running;
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops sampling once the source finishes', async () => {
    jest.useFakeTimers();

    try {
      dataSourcesRecognize.mockResolvedValue([matchFor('calendar')]);
      const { stage } = buildStage({ calendar: { ...emptyTotals, items: 3 } });
      const context = contextFor();

      await stage.run(context);

      const after = (context.progress as jest.Mock).mock.calls.length;
      await jest.advanceTimersByTimeAsync(10_000);

      // A leaked interval would keep writing progress for a finished stage.
      expect((context.progress as jest.Mock).mock.calls.length).toBe(after);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the media store handed to importers', () => {
  it('is a dot directory under the scratch tree, never the scratch root', async () => {
    // The catch-all `generic` importer walks the scratch tree after the
    // specialised importers have run. Given the root as its store, an MMS
    // importer's extracted parts were re-staged as standalone photos — each
    // with the SENDER's EXIF GPS as a position fix on the user. The walker
    // skips dot entries, so a dot directory keeps the store out of its reach.
    const seen: Array<{ mediaStoreDir?: string }> = [];

    dataSourcesRecognize.mockResolvedValue([
      {
        data_source: {
          name: 'sms_backup_restore',
          title: 'sms_backup_restore',
          icon: '',
          description: '',
          newFileImporter: () => ({
            recognize: async () => ({ confidence: 1 }),
            fileImport: async (_ctx: unknown, _entry: unknown, params: { mediaStoreDir?: string }) => {
              seen.push(params);
            },
          }),
        },
        recognition: { confidence: 1 },
      } as unknown as DataSourceRecognition,
    ]);

    const { stage } = buildStage();
    const context = contextFor();

    await stage.run(context);

    expect(seen).toHaveLength(1);
    expect(seen[0].mediaStoreDir).toBe(path.join(context.scratchDir, MEDIA_STORE_DIRNAME));
    expect(path.basename(seen[0].mediaStoreDir as string).startsWith('.')).toBe(true);
    expect(seen[0].mediaStoreDir).not.toBe(context.scratchDir);
  });
});
