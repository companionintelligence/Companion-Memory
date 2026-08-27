import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import {
  RETRIEVAL_POLICY_DEFAULTS,
  RETRIEVAL_SEED_MODES,
  type RetrievalPolicy,
  type RetrievalSeedMode,
} from '../constants';
import { RetrievalPolicyEntity } from '../entities/RetrievalPolicyEntity';

/**
 * How long a resolved policy is reused before the newest row is re-read.
 *
 * 60s, matching `PersonalizationService`'s profile cache. Retrieval is on the
 * hot path of every search, every recall and every agent turn, and the policy
 * changes at most a handful of times a year — re-reading it per query would be
 * a round-trip per query for a row that is almost always the same row. A minute
 * is also short enough that a promotion takes effect without a restart, which
 * is the whole point of the table.
 */
export const POLICY_CACHE_TTL_MS = 60_000;

/**
 * Reads the appliance's current retrieval policy, and FAILS OPEN.
 *
 * The contract every caller relies on: this never throws and never returns
 * nothing. If `ci.retrieval_policy` is empty, unreachable, or its newest row
 * fails validation, callers get {@link RETRIEVAL_POLICY_DEFAULTS} — the exact
 * constants that were compiled into `SearchService` and `RecallService` before
 * the table existed. Search then behaves precisely as it does today. Hard-
 * failing a retrieval path on a missing config row would be a much worse bug
 * than an unturned knob, and this service is where that promise is kept.
 *
 * Only the NEWEST version is ever read. Superseded rows are history; a bad
 * version is fixed by promoting v+1, never by editing or deleting a row (see
 * migration 20260826205634 and `domains/pipeline/versions.ts`).
 */
@Injectable()
export class RetrievalPolicyService {
  private cached: { policy: RetrievalPolicy; expiresAt: number } | null = null;

  constructor(
    @InjectRepository(RetrievalPolicyEntity)
    private readonly repository: Repository<RetrievalPolicyEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RetrievalPolicyService.name);
  }

  /** Drop the cache so the next {@link get} re-reads. Called after a promotion. */
  invalidateCache(): void {
    this.cached = null;
  }

  /**
   * The policy in force. Cached for {@link POLICY_CACHE_TTL_MS}.
   *
   * A fail-open result is cached like any other: an appliance whose database is
   * down should not add a failing query per search to whatever else is wrong
   * with it. The cost is that recovery is visible one TTL late, which is the
   * right trade for a value that changes a few times a year.
   */
  async get(): Promise<RetrievalPolicy> {
    const cached = this.cached;

    if (cached && cached.expiresAt > Date.now()) {
      return cached.policy;
    }

    const policy = await this.load();

    this.cached = { policy, expiresAt: Date.now() + POLICY_CACHE_TTL_MS };

    return policy;
  }

  private async load(): Promise<RetrievalPolicy> {
    let row: RetrievalPolicyEntity | undefined;

    try {
      [row] = await this.repository.find({ order: { version: 'DESC' }, take: 1 });
    } catch (error) {
      // Unreachable table, missing migration, dead pool — all the same answer.
      this.logger.warn(
        `ci.retrieval_policy could not be read (${error instanceof Error ? error.message : String(error)}); ` +
          'falling back to the compiled-in retrieval constants',
      );

      return RETRIEVAL_POLICY_DEFAULTS;
    }

    if (!row) {
      // Not an error: an appliance whose migration has not run yet, or whose
      // operator deleted the seed, gets today's behaviour rather than none.
      return RETRIEVAL_POLICY_DEFAULTS;
    }

    const policy = RetrievalPolicyService.toPolicy(row);

    if (!policy) {
      this.logger.warn(
        `ci.retrieval_policy v${row.version} failed validation; falling back to the compiled-in ` +
          'retrieval constants. Supersede it with v' +
          String(row.version + 1) +
          ' rather than editing the row.',
      );

      return RETRIEVAL_POLICY_DEFAULTS;
    }

    return policy;
  }

  /**
   * Row → policy, or `null` if the row cannot be trusted.
   *
   * The table's CHECK constraints already refuse every shape rejected here.
   * This is the second gate anyway, because two of these numbers are
   * INTERPOLATED into SQL rather than bound as parameters (the `ts_rank` weight
   * literal and the embedding boost factor), and `double precision` columns
   * still hand back `NaN` and `Infinity`, which no `BETWEEN` catches. Whole-row
   * rejection rather than per-field repair: a policy half-taken from the table
   * and half from the defaults is a version number that describes nothing.
   */
  private static toPolicy(row: RetrievalPolicyEntity): RetrievalPolicy | null {
    const inRange = (value: number, min: number, max: number): boolean =>
      Number.isFinite(value) && value >= min && value <= max;

    const weights = {
      d: Number(row.tsRankWeightD),
      c: Number(row.tsRankWeightC),
      b: Number(row.tsRankWeightB),
      a: Number(row.tsRankWeightA),
    };

    if (!Object.values(weights).every((weight) => inRange(weight, 0, 1))) {
      return null;
    }

    const embeddingBoostFactor = Number(row.embeddingBoostFactor);
    const semanticDistanceThreshold = Number(row.semanticDistanceThreshold);
    const semanticMaxResults = Number(row.semanticMaxResults);
    const recallMessageResults = Number(row.recallMessageResults);
    const groundedSimilarityFloor = Number(row.groundedSimilarityFloor);
    const anchoredDepthMultiplier = Number(row.anchoredDepthMultiplier);
    const recallMessageDistanceFloor =
      row.recallMessageDistanceFloor === null || row.recallMessageDistanceFloor === undefined
        ? null
        : Number(row.recallMessageDistanceFloor);

    if (
      !inRange(embeddingBoostFactor, 0, Number.MAX_SAFE_INTEGER) ||
      // Cosine distance is in [0, 2]; a floor of exactly 0 admits nothing.
      !inRange(semanticDistanceThreshold, Number.MIN_VALUE, 2) ||
      !Number.isInteger(semanticMaxResults) ||
      semanticMaxResults < 1 ||
      !Number.isInteger(recallMessageResults) ||
      recallMessageResults < 1 ||
      !inRange(groundedSimilarityFloor, 0, 1) ||
      !inRange(anchoredDepthMultiplier, 1, Number.MAX_SAFE_INTEGER) ||
      (recallMessageDistanceFloor !== null && !inRange(recallMessageDistanceFloor, Number.MIN_VALUE, 2))
    ) {
      return null;
    }

    if (!RetrievalPolicyService.isSeedMode(row.recallSeedMode)) {
      return null;
    }

    return {
      version: row.version,
      tsRankWeights: weights,
      embeddingBoostFactor,
      semanticDistanceThreshold,
      semanticMaxResults,
      recallMessageResults,
      recallMessageDistanceFloor,
      recallSeedMode: row.recallSeedMode,
      groundedSimilarityFloor,
      anchoredDepthMultiplier,
    };
  }

  private static isSeedMode(value: string): value is RetrievalSeedMode {
    return (RETRIEVAL_SEED_MODES as readonly string[]).includes(value);
  }
}
