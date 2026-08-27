import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Repository } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import {
  RETRIEVAL_POLICY_DEFAULTS,
  type RetrievalPolicy,
  sqlNumberLiteral,
  tsRankWeightsLiteral,
} from '../constants';
import type { RetrievalPolicyEntity } from '../entities/RetrievalPolicyEntity';
import { POLICY_CACHE_TTL_MS, RetrievalPolicyService } from '../services/RetrievalPolicyService';

/**
 * The point of `ci.retrieval_policy` is that promoting v1 changes NOTHING: the
 * table is seeded with the constants that were compiled into `SearchService`
 * and `RecallService`, and every reader falls back to those same constants when
 * the table is empty or unreachable. Two things therefore have to be pinned
 * against literals rather than against each other:
 *
 *   1. `RETRIEVAL_POLICY_DEFAULTS` holds the numbers that were in the two
 *      services before this change (the first describe below), and
 *   2. the migration's seed row holds the same numbers (the last describe,
 *      which parses the migration file rather than trusting a second list).
 *
 * Asserting the defaults against themselves would be vacuous, so the literals
 * are written out by hand here, sourced from `SearchService.ts` (TS_RANK_WEIGHTS
 * '{0.1, 0.2, 0.4, 1.0}', EMBEDDING_BOOST_FACTOR 0.5, SEMANTIC_DISTANCE_THRESHOLD
 * 0.5, SEMANTIC_MAX_RESULTS 25) and `RecallService.ts` (MESSAGE_RESULTS 10,
 * MESSAGE_DISTANCE_FLOOR undefined, SEED_MODE 'boosted',
 * GROUNDED_SIMILARITY_FLOOR 0.7, ANCHORED_DEPTH_MULTIPLIER 2) as of the commit
 * that introduced the policy table.
 */

const MIGRATION_PATH = path.join(
  __dirname,
  '../../../../db/postgres/migrations/20260826205634_create_retrieval_policy.sql',
);

function makeRow(overrides: Partial<RetrievalPolicyEntity> = {}): RetrievalPolicyEntity {
  return {
    version: 1,
    tsRankWeightD: 0.1,
    tsRankWeightC: 0.2,
    tsRankWeightB: 0.4,
    tsRankWeightA: 1.0,
    embeddingBoostFactor: 0.5,
    semanticDistanceThreshold: 0.5,
    semanticMaxResults: 25,
    recallMessageResults: 10,
    recallMessageDistanceFloor: null,
    recallSeedMode: 'boosted',
    groundedSimilarityFloor: 0.7,
    anchoredDepthMultiplier: 2,
    promotedAt: new Date('2026-08-26T20:56:34.000Z'),
    promotedFromEvalRun: null,
    notes: 'Baseline.',
    ...overrides,
  };
}

function makeService(rows: RetrievalPolicyEntity[] | Error = []) {
  const find = jest
    .fn()
    .mockImplementation(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)));
  const repository = { find } as unknown as Repository<RetrievalPolicyEntity>;
  const warn = jest.fn();
  const logger = { setContext() {}, warn, log() {} } as unknown as LoggerService;

  return { service: new RetrievalPolicyService(repository, logger), find, warn };
}

describe('RETRIEVAL_POLICY_DEFAULTS — the compiled-in baseline', () => {
  it('is byte-for-byte the constants SearchService and RecallService used to hold', () => {
    // Literals, deliberately. This is the test that would fail if somebody
    // "tuned" the defaults instead of promoting a new policy version.
    expect(RETRIEVAL_POLICY_DEFAULTS.tsRankWeights).toStrictEqual({ d: 0.1, c: 0.2, b: 0.4, a: 1.0 });
    expect(RETRIEVAL_POLICY_DEFAULTS.embeddingBoostFactor).toBe(0.5);
    expect(RETRIEVAL_POLICY_DEFAULTS.semanticDistanceThreshold).toBe(0.5);
    expect(RETRIEVAL_POLICY_DEFAULTS.semanticMaxResults).toBe(25);
    expect(RETRIEVAL_POLICY_DEFAULTS.recallMessageResults).toBe(10);
    // The constant was `const MESSAGE_DISTANCE_FLOOR: number | undefined = undefined`
    // — "inherit searchMessages' own default". `null` is how a nullable column
    // spells that; RecallService forwards it as `?? undefined`.
    expect(RETRIEVAL_POLICY_DEFAULTS.recallMessageDistanceFloor).toBeNull();
    expect(RETRIEVAL_POLICY_DEFAULTS.recallSeedMode).toBe('boosted');
    expect(RETRIEVAL_POLICY_DEFAULTS.groundedSimilarityFloor).toBe(0.7);
    expect(RETRIEVAL_POLICY_DEFAULTS.anchoredDepthMultiplier).toBe(2);
  });

  it('renders the ts_rank literal SearchService used to inline, character for character', () => {
    // The old line was `const TS_RANK_WEIGHTS = '{0.1, 0.2, 0.4, 1.0}';`. Any
    // reformatting here silently rewrites the generated SQL.
    expect(tsRankWeightsLiteral(RETRIEVAL_POLICY_DEFAULTS.tsRankWeights)).toBe('{0.1, 0.2, 0.4, 1.0}');
  });

  it('renders the embedding boost the way the old template literal did', () => {
    // `${EMBEDDING_BOOST_FACTOR}` on 0.5 produced "0.5".
    expect(sqlNumberLiteral(RETRIEVAL_POLICY_DEFAULTS.embeddingBoostFactor, 'boost')).toBe('0.5');
  });

  it('is frozen, so a reader cannot poison the shared fallback object', () => {
    expect(Object.isFrozen(RETRIEVAL_POLICY_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(RETRIEVAL_POLICY_DEFAULTS.tsRankWeights)).toBe(true);
  });
});

describe('tsRankWeightsLiteral / sqlNumberLiteral — SQL-safety', () => {
  it('never emits exponential notation for an integral multiplier', () => {
    expect(sqlNumberLiteral(2, 'x')).toBe('2.0');
    expect(sqlNumberLiteral(10, 'x')).toBe('10.0');
    expect(sqlNumberLiteral(0, 'x')).toBe('0.0');
  });

  it('refuses a weight outside [0, 1] rather than writing it into a statement', () => {
    expect(() => tsRankWeightsLiteral({ d: 0.1, c: 0.2, b: 0.4, a: 1.5 })).toThrow(RangeError);
    expect(() => tsRankWeightsLiteral({ d: -1, c: 0.2, b: 0.4, a: 1 })).toThrow(RangeError);
  });

  it('refuses NaN and Infinity, which no SQL CHECK constraint catches', () => {
    expect(() => tsRankWeightsLiteral({ d: Number.NaN, c: 0.2, b: 0.4, a: 1 })).toThrow(RangeError);
    expect(() => sqlNumberLiteral(Number.POSITIVE_INFINITY, 'boost')).toThrow(RangeError);
  });
});

describe('RetrievalPolicyService.get — fail open', () => {
  it('returns the compiled-in defaults when the table is empty', async () => {
    const { service } = makeService([]);

    await expect(service.get()).resolves.toStrictEqual(RETRIEVAL_POLICY_DEFAULTS);
  });

  it('returns the compiled-in defaults when the table cannot be read at all', async () => {
    const { service, warn } = makeService(new Error('relation "ci.retrieval_policy" does not exist'));

    // The whole contract: a retrieval path must never hard-fail on a missing
    // config row. It degrades to today's behaviour and says so in the log.
    await expect(service.get()).resolves.toStrictEqual(RETRIEVAL_POLICY_DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/falling back to the compiled-in retrieval constants/);
  });

  it('reads only the newest version', async () => {
    const { service, find } = makeService([makeRow({ version: 7 })]);

    await service.get();

    expect(find).toHaveBeenCalledWith({ order: { version: 'DESC' }, take: 1 });
  });
});

describe('RetrievalPolicyService.get — a seeded v1 is a no-op', () => {
  it('resolves every knob to exactly the compiled-in value', async () => {
    const { service } = makeService([makeRow()]);

    const policy = await service.get();

    expect(policy).toStrictEqual({ ...RETRIEVAL_POLICY_DEFAULTS, version: 1 });
  });

  it('reports version 1 rather than the fallback marker, so the two are distinguishable', async () => {
    const { service } = makeService([makeRow()]);
    const { service: empty } = makeService([]);

    expect((await service.get()).version).toBe(1);
    expect((await empty.get()).version).toBe(0);
  });
});

describe('RetrievalPolicyService.get — a promoted v2 is picked up', () => {
  it('carries every changed knob through', async () => {
    const { service } = makeService([
      makeRow({
        version: 2,
        tsRankWeightD: 0.05,
        tsRankWeightC: 0.25,
        tsRankWeightB: 0.5,
        tsRankWeightA: 0.9,
        embeddingBoostFactor: 0.8,
        semanticDistanceThreshold: 0.42,
        semanticMaxResults: 40,
        recallMessageResults: 15,
        recallMessageDistanceFloor: 0.35,
        recallSeedMode: 'hybrid',
        groundedSimilarityFloor: 0.75,
        anchoredDepthMultiplier: 3,
      }),
    ]);

    const policy = await service.get();

    expect(policy).toStrictEqual({
      version: 2,
      tsRankWeights: { d: 0.05, c: 0.25, b: 0.5, a: 0.9 },
      embeddingBoostFactor: 0.8,
      semanticDistanceThreshold: 0.42,
      semanticMaxResults: 40,
      recallMessageResults: 15,
      recallMessageDistanceFloor: 0.35,
      recallSeedMode: 'hybrid',
      groundedSimilarityFloor: 0.75,
      anchoredDepthMultiplier: 3,
    } satisfies RetrievalPolicy);
  });
});

describe('RetrievalPolicyService.get — a row that cannot be trusted', () => {
  const rejected: [string, Partial<RetrievalPolicyEntity>][] = [
    ['a ts_rank weight above 1', { tsRankWeightA: 1.4 }],
    // `double precision` really does hand back NaN, and no BETWEEN catches it —
    // this is the case the CHECK constraints cannot cover.
    ['a NaN weight', { tsRankWeightB: Number.NaN }],
    ['an infinite boost', { embeddingBoostFactor: Number.POSITIVE_INFINITY }],
    ['a negative boost', { embeddingBoostFactor: -0.5 }],
    ['a zero distance threshold, which would admit nothing', { semanticDistanceThreshold: 0 }],
    ['a distance threshold past the cosine range', { semanticDistanceThreshold: 2.5 }],
    ['a LIMIT of zero', { semanticMaxResults: 0 }],
    ['a fractional LIMIT', { semanticMaxResults: 12.5 }],
    ['a message K of zero', { recallMessageResults: 0 }],
    ['a similarity floor above 1', { groundedSimilarityFloor: 1.2 }],
    [
      'a depth multiplier below 1, which would cut the anchored channel shallower',
      { anchoredDepthMultiplier: 0.5 },
    ],
    ['a seed mode SearchService does not have', { recallSeedMode: 'magic' }],
  ];

  it.each(rejected)('falls back to the defaults on %s', async (_label, overrides) => {
    const { service, warn } = makeService([makeRow({ version: 3, ...overrides })]);

    await expect(service.get()).resolves.toStrictEqual(RETRIEVAL_POLICY_DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/failed validation/);
    // Never "repair" the row in place — the fix is v4.
    expect(warn.mock.calls[0][0]).toMatch(/Supersede it with v4/);
  });

  it('accepts an explicit message floor inside the cosine range', async () => {
    const { service } = makeService([makeRow({ version: 3, recallMessageDistanceFloor: 0.25 })]);

    await expect(service.get()).resolves.toMatchObject({ recallMessageDistanceFloor: 0.25 });
  });
});

describe('RetrievalPolicyService.get — caching', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reads the row once per TTL, not once per search', async () => {
    const { service, find } = makeService([makeRow()]);

    await service.get();
    await service.get();
    await service.get();

    expect(find).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the TTL has elapsed, so a promotion lands without a restart', async () => {
    jest.useFakeTimers();
    const { service, find } = makeService([makeRow()]);

    await service.get();
    jest.advanceTimersByTime(POLICY_CACHE_TTL_MS + 1);
    await service.get();

    expect(find).toHaveBeenCalledTimes(2);
  });

  it('caches the fail-open answer too, so a dead database is not one failing query per search', async () => {
    const { service, find } = makeService(new Error('pool exhausted'));

    await service.get();
    await service.get();

    expect(find).toHaveBeenCalledTimes(1);
  });

  it('invalidateCache forces the next read', async () => {
    const { service, find } = makeService([makeRow()]);

    await service.get();
    service.invalidateCache();
    await service.get();

    expect(find).toHaveBeenCalledTimes(2);
  });
});

describe('migration 20260826205634 — the seeded v1 row', () => {
  /**
   * Parsed out of the migration file rather than restated, because a second
   * hand-written list of the same numbers is exactly the thing that drifts. If
   * the seed and the compiled-in defaults ever disagree, promoting v1 stops
   * being a no-op and this fails.
   */
  function seededValues(): Record<string, string> {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    const insert = /INSERT INTO ci\.retrieval_policy \(([\s\S]*?)\) VALUES \(([\s\S]*?)\) ON CONFLICT/.exec(
      sql,
    );

    if (!insert) {
      throw new Error('could not find the v1 seed INSERT in the migration');
    }

    const columns = insert[1]
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean);
    // Only the leading scalar columns are read; `notes` is the last value and
    // contains commas of its own, so it is deliberately not zipped.
    const values = insert[2].split(',').map((value) => value.trim());

    const pairs: Record<string, string> = {};

    for (let index = 0; index < columns.length - 1; index += 1) {
      pairs[columns[index]] = values[index];
    }

    return pairs;
  }

  it('seeds version 1', () => {
    expect(seededValues().version).toBe('1');
  });

  it('seeds every knob with the compiled-in default, so promoting v1 changes nothing', () => {
    const seeded = seededValues();
    const asNumber = (column: string): number => Number(seeded[column]);

    expect(asNumber('ts_rank_weight_d')).toBe(RETRIEVAL_POLICY_DEFAULTS.tsRankWeights.d);
    expect(asNumber('ts_rank_weight_c')).toBe(RETRIEVAL_POLICY_DEFAULTS.tsRankWeights.c);
    expect(asNumber('ts_rank_weight_b')).toBe(RETRIEVAL_POLICY_DEFAULTS.tsRankWeights.b);
    expect(asNumber('ts_rank_weight_a')).toBe(RETRIEVAL_POLICY_DEFAULTS.tsRankWeights.a);
    expect(asNumber('embedding_boost_factor')).toBe(RETRIEVAL_POLICY_DEFAULTS.embeddingBoostFactor);
    expect(asNumber('semantic_distance_threshold')).toBe(RETRIEVAL_POLICY_DEFAULTS.semanticDistanceThreshold);
    expect(asNumber('semantic_max_results')).toBe(RETRIEVAL_POLICY_DEFAULTS.semanticMaxResults);
    expect(asNumber('recall_message_results')).toBe(RETRIEVAL_POLICY_DEFAULTS.recallMessageResults);
    expect(asNumber('grounded_similarity_floor')).toBe(RETRIEVAL_POLICY_DEFAULTS.groundedSimilarityFloor);
    expect(asNumber('anchored_depth_multiplier')).toBe(RETRIEVAL_POLICY_DEFAULTS.anchoredDepthMultiplier);
    expect(seeded.recall_message_distance_floor).toBe('NULL');
    expect(seeded.recall_seed_mode).toBe(`'${RETRIEVAL_POLICY_DEFAULTS.recallSeedMode}'`);
  });

  it('records that v1 came from no eval run', () => {
    // v1 is not a measurement, it is what the code already did. A uuid here
    // would be a claim nothing supports.
    expect(seededValues().promoted_from_eval_run).toBe('NULL');
  });
});
