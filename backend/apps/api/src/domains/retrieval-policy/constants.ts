/**
 * The compiled-in retrieval policy: the baseline every reader falls back to.
 *
 * These are the exact literals that lived in `SearchService` and `RecallService`
 * before `ci.retrieval_policy` existed, and migration 20260826205634 seeds
 * version 1 of the table with the same numbers. Promoting to v1 is therefore a
 * behavioural no-op, and today's behaviour is the tuning baseline by
 * construction rather than by two lists agreeing.
 *
 * They are also the FAIL-OPEN value. `RetrievalPolicyService` returns this
 * object whenever the table is empty, unreachable, or holds a newest row that
 * fails validation — search degrades to exactly what it does today, never to
 * nothing. A retrieval path that hard-failed on a missing config row would be a
 * much worse bug than an unturned knob.
 *
 * @module RetrievalPolicyConstants
 */

/** The four `ts_rank` weight multipliers, lowest-priority first. */
export type TsRankWeights = {
  /** Weight D — properties, bulk content (ingestion weight < 2). */
  d: number;
  /** Weight C — categories, types, URLs (ingestion weight 2-3). */
  c: number;
  /** Weight B — descriptions, summaries (ingestion weight 4-7). */
  b: number;
  /** Weight A — names, titles, primary identifiers (ingestion weight 10+). */
  a: number;
};

/** The search modes `SearchService.search` accepts. Mirrors its `mode` union. */
export const RETRIEVAL_SEED_MODES = ['semantic', 'keyword', 'boosted', 'hybrid', 'auto'] as const;

export type RetrievalSeedMode = (typeof RETRIEVAL_SEED_MODES)[number];

/**
 * One version of the retrieval policy, as the readers consume it.
 *
 * Every field maps 1:1 to a column of `ci.retrieval_policy` and to a constant
 * that used to be a module-level literal; the doc comment on each names the
 * constant it replaced so `git log -S` still finds the history.
 */
export type RetrievalPolicy = {
  /**
   * Which version produced this object. `0` is reserved for the compiled-in
   * fallback below — a value the table's own `version >= 1` CHECK cannot
   * produce, so "this came from the database" and "this is the fallback" are
   * distinguishable in a log line without a second field.
   */
  version: number;

  /** Was `SearchService.TS_RANK_WEIGHTS` (`'{0.1, 0.2, 0.4, 1.0}'`). */
  tsRankWeights: TsRankWeights;
  /** Was `SearchService.EMBEDDING_BOOST_FACTOR`. */
  embeddingBoostFactor: number;
  /** Was `SearchService.SEMANTIC_DISTANCE_THRESHOLD`. Cosine DISTANCE, smaller is stricter. */
  semanticDistanceThreshold: number;
  /** Was `SearchService.SEMANTIC_MAX_RESULTS`. */
  semanticMaxResults: number;

  /** Was `RecallService.MESSAGE_RESULTS`. */
  recallMessageResults: number;
  /**
   * Was `RecallService.MESSAGE_DISTANCE_FLOOR`, which is literally
   * `undefined` — "inherit whatever `searchMessages` defaults to". `null` here,
   * because the column is nullable and `undefined` is not a value a row can
   * hold; readers forward `?? undefined`.
   */
  recallMessageDistanceFloor: number | null;
  /** Was `RecallService.SEED_MODE`. */
  recallSeedMode: RetrievalSeedMode;
  /** Was `RecallService.GROUNDED_SIMILARITY_FLOOR`. Cosine SIMILARITY, larger is stricter. */
  groundedSimilarityFloor: number;
  /** Was `RecallService.ANCHORED_DEPTH_MULTIPLIER`. */
  anchoredDepthMultiplier: number;
};

/**
 * Today's constants, verbatim. Kept `readonly` and deeply frozen so a reader
 * that mutates what it got back cannot poison the fallback for every subsequent
 * caller — the object is shared, not copied, on every fail-open return.
 */
export const RETRIEVAL_POLICY_DEFAULTS: RetrievalPolicy = Object.freeze({
  version: 0,
  tsRankWeights: Object.freeze({ d: 0.1, c: 0.2, b: 0.4, a: 1.0 }),
  embeddingBoostFactor: 0.5,
  semanticDistanceThreshold: 0.5,
  semanticMaxResults: 25,
  recallMessageResults: 10,
  recallMessageDistanceFloor: null,
  recallSeedMode: 'boosted',
  groundedSimilarityFloor: 0.7,
  anchoredDepthMultiplier: 2,
}) as RetrievalPolicy;

/**
 * Render `ts_rank`'s weight-array literal from four validated numbers.
 *
 * `ts_rank('{...}', vector, tsquery)` takes its weights as a Postgres array
 * LITERAL, not as a bind parameter, so this string is interpolated straight
 * into the statement. Every value therefore has to be proven to be a plain
 * number here: anything non-finite or outside [0, 1] is refused and the caller
 * falls back rather than building SQL out of it.
 *
 * The formatting is deliberately trailing-zero-trimmed rather than
 * `toFixed(6)`, so `RETRIEVAL_POLICY_DEFAULTS` renders `'{0.1, 0.2, 0.4, 1.0}'`
 * — byte-identical to the literal the constant held. Numerically it would not
 * matter; for reading a diff of the generated SQL it does.
 *
 * @throws if any weight is not a finite number in [0, 1].
 */
export function tsRankWeightsLiteral(weights: TsRankWeights): string {
  const render = (value: number, name: string): string => {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`ts_rank weight ${name} must be a finite number in [0, 1], got ${String(value)}`);
    }

    // Fixed notation first (never exponential, so never a token Postgres would
    // read differently), then trim the padding back off.
    const fixed = value.toFixed(6).replace(/0+$/, '');

    return fixed.endsWith('.') ? `${fixed}0` : fixed;
  };

  return `{${render(weights.d, 'D')}, ${render(weights.c, 'C')}, ${render(weights.b, 'B')}, ${render(weights.a, 'A')}}`;
}

/**
 * Render a non-negative multiplier for interpolation into SQL.
 *
 * `boostedKeywordSearch` multiplies its score by `(1 + <boost> * similarity)`
 * with the boost written into the statement text, for the same reason as the
 * weights above: it sits inside an expression, not in a parameter slot.
 *
 * @throws if the value is not a finite, non-negative number.
 */
export function sqlNumberLiteral(value: number, name: string): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number, got ${String(value)}`);
  }

  const fixed = value.toFixed(6).replace(/0+$/, '');

  return fixed.endsWith('.') ? `${fixed}0` : fixed;
}
