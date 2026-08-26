import type { LoggerService } from '@ci/common/logging';
import { RETRIEVAL_POLICY_DEFAULTS } from '@ci/domains/retrieval-policy';
import { SearchService } from '@ci/domains/search-next';

import type { RecallProbeResultEntity } from '../../entities/RecallProbeResultEntity';
import {
  EF_SEARCH_VARIANTS,
  MIN_POPULATION,
  PROBE_K,
  PROBED_TYPES,
  RecallProbeService,
  SAMPLES_PER_TYPE,
  TYPES_PER_RUN,
  WIDEST_EF_SEARCH,
  pickProbeUser,
  recallAt,
  selectProbeTypes,
  summarizeLeg,
} from '../RecallProbeService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAS TO BE TRUE FOR A RECALL NUMBER TO MEAN ANYTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A probe that reports 1.0 because it ran the same plan twice is worse than no
 * probe: it is a green light nobody earned. So the fake database below does not
 * answer queries — it answers PLANS. It watches the `SET LOCAL` statements the
 * service issues inside each transaction and replies as a real Postgres would:
 * an exhaustive answer when index scans are off, a progressively less lossy one
 * as `hnsw.ef_search` widens. Every assertion here is therefore about what the
 * service actually asked the database to do.
 *
 * `SearchService` is REAL, not a double. The statement being measured has to be
 * the statement production runs, and the only way to keep that true as the SQL
 * changes is to build it with the same function `semanticSearch` uses.
 *
 * The live-schema half — that these statements parse, that `SET LOCAL
 * hnsw.ef_search` is a setting this Postgres has, that a stored embedding can
 * be fed back as a query vector — is `RecallProbeService.integration.spec.ts`.
 */

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';

/** The exact answer every leg is scored against: 25 ids, most similar first. */
const EXACT_IDS = Array.from({ length: PROBE_K }, (_, index) => `exact-${index}`);

/**
 * How much of the exact answer the fake index returns at each `ef_search`.
 * Rising, because that is the shape a real HNSW scan has and the shape an
 * operator reading this table is looking for.
 */
const HITS_BY_EF = new Map<number | null, number>([
  [null, 5],
  [100, 10],
  [200, 15],
  [400, 25],
]);

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

interface Harness {
  service: RecallProbeService;
  saved: RecallProbeResultEntity[];
  /** Every statement issued, in order, tagged with the transaction it belonged to. */
  statements: Array<{ transaction: number; sql: string }>;
}

function statementTimeout(): Error & { code: string } {
  return Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
}

function makeHarness(
  options: {
    populations?: Array<{ user_id: string; entity_type: string; population: string }>;
    /** Sample vectors returned per type. */
    sampleCount?: number;
    /** Throw a statement timeout on the exhaustive leg of these sample indexes. */
    exactTimeoutsAt?: number[];
    /** Milliseconds `Date.now()` advances per statement, for deadline tests. */
    clockStepMs?: number;
    /**
     * Fake-clock cost of each round trip, so a recorded duration is arithmetic
     * rather than wall clock: `measured` for the statement being probed,
     * `overhead` for BEGIN, for each `SET LOCAL` and for COMMIT.
     */
    costMs?: { measured: number; overhead: number };
    /** Types whose sample query fails outright, as a broken statement would. */
    brokenTypes?: string[];
  } = {},
): Harness {
  const populations = options.populations ?? [
    { user_id: USER, entity_type: 'note', population: String(MIN_POPULATION * 40) },
  ];
  const sampleCount = options.sampleCount ?? SAMPLES_PER_TYPE;
  const saved: RecallProbeResultEntity[] = [];
  const statements: Array<{ transaction: number; sql: string }> = [];
  const populationOf = new Map(populations.map((row) => [row.entity_type, Number(row.population)]));

  let transaction = 0;
  let exhaustive = false;
  let efSearch: number | null = null;
  let sampleIndex = -1;
  let probedType = '';

  let clock = Date.now();

  if (options.costMs != null) {
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  }

  const spend = (ms: number): void => {
    clock += ms;
  };

  const runner = {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => {
      spend(options.costMs?.overhead ?? 0);
      transaction += 1;
      exhaustive = false;
      efSearch = null;
    }),
    commitTransaction: jest.fn(async () => {
      spend(options.costMs?.overhead ?? 0);
    }),
    rollbackTransaction: jest.fn(async () => {
      spend(options.costMs?.overhead ?? 0);
    }),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ transaction, sql });
      spend(sql.startsWith('SET LOCAL') ? (options.costMs?.overhead ?? 0) : (options.costMs?.measured ?? 0));

      if (sql.startsWith('SET LOCAL enable_indexscan')) {
        exhaustive = true;

        return [];
      }

      if (sql.startsWith('SET LOCAL hnsw.ef_search')) {
        efSearch = Number(sql.split('=')[1]);

        return [];
      }

      if (sql.startsWith('SET LOCAL')) {
        return [];
      }

      if (sql.includes('ORDER BY random()')) {
        sampleIndex = -1;
        probedType = String(params[1]);

        if (options.brokenTypes?.includes(String(params[1]))) {
          throw new Error('relation "ci_search.embeddings" does not exist');
        }

        return Array.from({ length: sampleCount }, (_, index) => ({
          embedding: `[${index}.0,0.5]`,
        }));
      }

      // The production statement. Which answer it gets depends entirely on the
      // settings the service put on this transaction — which is the whole point.
      if (exhaustive) {
        sampleIndex += 1;

        if (options.exactTimeoutsAt?.includes(sampleIndex)) {
          throw statementTimeout();
        }

        return EXACT_IDS.map((entity_id) => ({ entity_id }));
      }

      // A type small enough to fit inside the widest candidate list comes back
      // whole whatever the graph does — recall 1.0 by arithmetic, which is the
      // reading MIN_POPULATION exists to keep out of the table.
      const fitsInCandidateList = (populationOf.get(probedType) ?? 0) <= WIDEST_EF_SEARCH;
      const hits = fitsInCandidateList ? EXACT_IDS.length : (HITS_BY_EF.get(efSearch) ?? 0);

      return EXACT_IDS.slice(0, hits).map((entity_id) => ({ entity_id }));
    }),
  };

  const dataSource = {
    createQueryRunner: () => runner,
    query: jest.fn(async () => populations),
  };

  const repository = {
    create: (row: RecallProbeResultEntity) => row,
    save: jest.fn(async (rows: RecallProbeResultEntity[]) => {
      saved.push(...rows);

      return rows;
    }),
    delete: jest.fn(async () => ({ affected: 0 })),
  };

  if (options.clockStepMs != null) {
    const started = Date.now();
    let ticks = 0;

    jest.spyOn(Date, 'now').mockImplementation(() => {
      ticks += 1;

      return started + ticks * (options.clockStepMs as number);
    });
  }

  const searchService = new SearchService(
    dataSource as never,
    { generateEmbeddingString: jest.fn() } as never,
    { get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS) } as never,
    { send: jest.fn().mockResolvedValue([]) } as never,
  );

  return {
    service: new RecallProbeService(dataSource as never, repository as never, searchService, noopLogger),
    saved,
    statements,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('RecallProbeService', () => {
  it('scores the production statement against an exhaustive one, at every ef_search', async () => {
    const { service, saved } = makeHarness();

    const run = await service.probe(new Date('2026-08-23T05:20:13.000Z'));

    expect(run.types).toEqual(['note']);
    expect(saved).toHaveLength(EF_SEARCH_VARIANTS.length);

    const byEf = new Map(saved.map((row) => [row.efSearch, row]));

    // 5/25, 10/25, 15/25, 25/25 — the fake index's hit counts, measured.
    expect(byEf.get(null)?.meanRecall).toBeCloseTo(0.2);
    expect(byEf.get(100)?.meanRecall).toBeCloseTo(0.4);
    expect(byEf.get(200)?.meanRecall).toBeCloseTo(0.6);
    expect(byEf.get(400)?.meanRecall).toBeCloseTo(1);

    for (const row of saved) {
      expect(row.entityType).toBe('note');
      expect(row.userId).toBe(USER);
      expect(row.k).toBe(PROBE_K);
      expect(row.samples).toBe(SAMPLES_PER_TYPE);
      expect(row.population).toBe(MIN_POPULATION * 40);
    }
  });

  it('counts the short answers as truncation, which is the post-filter signature', async () => {
    const { service, saved } = makeHarness();

    await service.probe(new Date('2026-08-23T05:20:13.000Z'));

    const byEf = new Map(saved.map((row) => [row.efSearch, row]));

    // Every default-ef sample came back with 5 rows where the exact answer had
    // 25: a filtered query returning less than its LIMIT while the answer exists.
    expect(byEf.get(null)?.truncatedSamples).toBe(SAMPLES_PER_TYPE);
    expect(byEf.get(null)?.meanAnnRows).toBe(5);
    expect(byEf.get(null)?.meanExactRows).toBe(PROBE_K);

    // At ef 400 the fake index returns the whole answer, so nothing is short.
    expect(byEf.get(400)?.truncatedSamples).toBe(0);
  });

  it('takes the exhaustive answer off the index and leaves the ANN legs on it', async () => {
    const { service, statements } = makeHarness({ sampleCount: 1 });

    await service.probe(new Date('2026-08-23T05:20:13.000Z'));

    const measured = statements.filter((statement) =>
      statement.sql.includes('FROM\n        ci_search.embeddings'),
    );

    expect(measured).toHaveLength(1 + EF_SEARCH_VARIANTS.length);

    const settingsFor = (transaction: number): string[] =>
      statements
        .filter((statement) => statement.transaction === transaction && statement.sql.startsWith('SET LOCAL'))
        .map((statement) => statement.sql);

    const [exact, ...ann] = measured;

    expect(settingsFor(exact.transaction)).toEqual([
      expect.stringContaining('statement_timeout'),
      'SET LOCAL enable_indexscan = off',
      'SET LOCAL enable_bitmapscan = off',
    ]);

    // The default leg sets no ef_search at all: pgvector's default is the thing
    // being measured, and naming a number here would measure that number.
    expect(settingsFor(ann[0].transaction)).toEqual([expect.stringContaining('statement_timeout')]);
    expect(settingsFor(ann[1].transaction)).toContain('SET LOCAL hnsw.ef_search = 100');
    expect(settingsFor(ann[2].transaction)).toContain('SET LOCAL hnsw.ef_search = 200');
    expect(settingsFor(ann[3].transaction)).toContain('SET LOCAL hnsw.ef_search = 400');

    // Nothing outlives its transaction: a bare SET would leak the probe's
    // planner settings onto the next query to borrow this pooled connection.
    for (const statement of statements) {
      expect(statement.sql.startsWith('SET ') && !statement.sql.startsWith('SET LOCAL ')).toBe(false);
    }
  });

  it('measures the statement SearchService itself builds', async () => {
    const { service, statements } = makeHarness({ sampleCount: 1 });
    const searchService = new SearchService(
      { query: jest.fn() } as never,
      { generateEmbeddingString: jest.fn() } as never,
      { get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS) } as never,
      { send: jest.fn().mockResolvedValue([]) } as never,
    );

    await service.probe(new Date('2026-08-23T05:20:13.000Z'));

    const expected = searchService.buildSemanticSearchPlan(USER, '[0.0,0.5]', {
      includeTypes: ['note'],
      maxResults: PROBE_K,
    });

    expect(statements.map((statement) => statement.sql)).toContain(expected.sql);
  });

  it('treats a timed-out exhaustive leg as a measurement, not a failure', async () => {
    const { service, saved } = makeHarness({ sampleCount: 4, exactTimeoutsAt: [0, 1] });

    const run = await service.probe(new Date('2026-08-23T05:20:13.000Z'));

    expect(run.rows).toHaveLength(EF_SEARCH_VARIANTS.length);

    for (const row of saved) {
      expect(row.exactTimeouts).toBe(2);
      // The two samples that survived still produced a number.
      expect(row.samples).toBe(2);
    }
  });

  it('stops at the run deadline and persists what it measured', async () => {
    // Each statement advances the clock a minute, so MAX_RUN_MS is spent long
    // before the 50th sample.
    const { service, saved } = makeHarness({ clockStepMs: 60_000 });

    const run = await service.probe(new Date('2026-08-23T05:20:13.000Z'));

    expect(run.deadlineHit).toBe(true);
    expect(saved.length).toBeGreaterThan(0);

    for (const row of saved) {
      expect(row.samples).toBeGreaterThan(0);
      expect(row.samples).toBeLessThan(SAMPLES_PER_TYPE);
    }
  });

  it('keeps the types it measured when one type fails outright', async () => {
    const { service, saved } = makeHarness({
      populations: [
        { user_id: USER, entity_type: 'note', population: String(MIN_POPULATION * 40) },
        { user_id: USER, entity_type: 'event', population: String(MIN_POPULATION * 40) },
      ],
      brokenTypes: ['note'],
      sampleCount: 2,
    });

    const run = await service.probe(new Date('2026-08-23T05:20:13.000Z'));

    // Sorted: which of the two the rotation happens to name first is not what
    // this test is about.
    expect([...run.types].sort()).toEqual(['event', 'note']);
    // A week's reading of the type that worked is worth more than a clean abort.
    expect(saved.map((row) => row.entityType)).toEqual(Array(EF_SEARCH_VARIANTS.length).fill('event'));
  });

  it('measures nothing when no index is big enough for the number to mean anything', async () => {
    const { service, saved } = makeHarness({
      populations: [{ user_id: USER, entity_type: 'note', population: String(MIN_POPULATION - 1) }],
    });

    const run = await service.probe(new Date('2026-08-23T05:20:13.000Z'));

    expect(run.userId).toBeNull();
    expect(run.types).toEqual([]);
    expect(saved).toHaveLength(0);
    // "Measured nothing" is what the cron warns about, and a warning without
    // the list of undersized types does not say why.
    expect(run.tooSmall).toEqual(['note']);
  });

  it('names a type under the population bar instead of writing its arithmetic 1.0', async () => {
    const { service, saved } = makeHarness({
      populations: [
        { user_id: USER, entity_type: 'note', population: String(MIN_POPULATION * 40) },
        // Small enough that the widest ef_search leg holds the whole type in its
        // candidate list, so the fake index hands back the exact answer at every
        // setting and recall is 1.0 before the graph has been asked anything.
        { user_id: USER, entity_type: 'event', population: String(WIDEST_EF_SEARCH) },
      ],
      sampleCount: 2,
    });

    const run = await service.probe(new Date('2026-08-23T05:20:13.000Z'));

    // The absent row IS the record: `mean_recall` is NOT NULL, so a row for a
    // type this small could only carry a 1.0 nobody could tell apart from a
    // measured one.
    expect(saved.map((row) => row.entityType)).toEqual(Array(EF_SEARCH_VARIANTS.length).fill('note'));
    expect(run.types).toEqual(['note']);
    expect(run.tooSmall).toEqual(['event']);

    // The type that IS in the table earned its number: at the server default the
    // index loses four fifths of the answer, which is what a measurement of a
    // population too large to hold in the candidate list looks like.
    expect(new Map(saved.map((row) => [row.efSearch, row])).get(null)?.meanRecall).toBeCloseTo(0.2);
  });

  it('times the statement and not the transaction it runs in', async () => {
    // A fake clock where only the statement being measured costs 100 ms and
    // every other round trip costs 7. The exact leg sets three settings and the
    // default ANN leg sets one, so a stopwatch that started at BEGIN would
    // record 135 and 121 — comparable to each other, and both wrong about what
    // the query cost.
    const { service, saved } = makeHarness({
      sampleCount: 3,
      costMs: { measured: 100, overhead: 7 },
    });

    await service.probe(new Date('2026-08-23T05:20:13.000Z'));

    expect(saved).toHaveLength(EF_SEARCH_VARIANTS.length);

    for (const row of saved) {
      expect(row.meanAnnMs).toBe(100);
      expect(row.meanExactMs).toBe(100);
    }
  });
});

describe('recallAt', () => {
  it('is the fraction of the exact answer the index returned', () => {
    expect(recallAt(['a', 'b', 'c', 'd'], ['a', 'c'])).toBe(0.5);
    expect(recallAt(['a', 'b'], ['a', 'b'])).toBe(1);
    // Rows the index returned that the exact answer does not contain cannot
    // raise recall — otherwise a leg that returns junk would score well.
    expect(recallAt(['a', 'b'], ['a', 'x', 'y', 'z'])).toBe(0.5);
  });
});

describe('summarizeLeg', () => {
  it('reports the worst sample as well as the mean', () => {
    const summary = summarizeLeg([
      { recall: 1, annRows: 25, exactRows: 25, annMs: 2, exactMs: 400 },
      { recall: 0.2, annRows: 5, exactRows: 25, annMs: 4, exactMs: 600 },
    ]);

    expect(summary.samples).toBe(2);
    expect(summary.meanRecall).toBeCloseTo(0.6);
    expect(summary.minRecall).toBeCloseTo(0.2);
    expect(summary.truncatedSamples).toBe(1);
    expect(summary.meanExactMs).toBe(500);
  });
});

describe('selectProbeTypes', () => {
  it('advances a whole window, so consecutive runs share no type', () => {
    const eligible = [...PROBED_TYPES];

    expect(selectProbeTypes(eligible, 0)).toEqual([eligible[0], eligible[1], eligible[2]]);
    expect(selectProbeTypes(eligible, 1)).toEqual([eligible[3], eligible[4], eligible[5]]);
  });

  it('covers every eligible type within one sweep', () => {
    const eligible = [...PROBED_TYPES];
    const sweep = Math.ceil(eligible.length / TYPES_PER_RUN);
    const covered = new Set(
      Array.from({ length: sweep }, (_, week) => selectProbeTypes(eligible, week)).flat(),
    );

    // The rotation is what makes a per-type trend readable: a type nobody
    // measures for months has no trend, whatever the table says.
    expect(covered.size).toBe(eligible.length);
  });

  it('never repeats a type inside one run, however short the eligible list', () => {
    // One window covers the whole list, so there is nothing to rotate through
    // and every week returns it in declaration order.
    expect(selectProbeTypes(['note', 'event'], 3)).toEqual(['note', 'event']);
    expect(selectProbeTypes(['note'], 9)).toEqual(['note']);
    expect(selectProbeTypes([], 4)).toEqual([]);
  });
});

describe('pickProbeUser', () => {
  it('probes the largest index and ignores rows too small to measure', () => {
    expect(
      pickProbeUser([
        { userId: USER, entityType: 'note', population: MIN_POPULATION * 3 },
        { userId: OTHER_USER, entityType: 'note', population: MIN_POPULATION * 2 },
        { userId: OTHER_USER, entityType: 'event', population: MIN_POPULATION - 1 },
      ]),
    ).toBe(USER);

    expect(pickProbeUser([{ userId: USER, entityType: 'note', population: MIN_POPULATION - 1 }])).toBeNull();
  });
});
