import type { Item, ObjectDuplicateGroup, ObjectDuplicateReason } from '@ci/domains/memory';

import {
  CLEAN_OBJECT_DUPLICATE_DETECT_STAGE_ID,
  MIN_OBJECT_CANDIDATE_SCORE,
  OBJECT_DUPLICATE_DETECT_SOURCE,
  OBJECT_DUPLICATE_DETECT_VERSION,
  OBJECT_REASON_SCORES,
  buildObjectCandidates,
  objectDuplicateDetectStageVersion,
} from '../clean/ObjectDuplicateDetectStage';

/**
 * `clean.object_duplicate_detect` — the pure half.
 *
 * Everything here is a function of its arguments: the version derivation, the
 * candidate-set declaration, and the group → pair transformation. The half that
 * needs a database (does a duplicate produce a row, does a blocked pair stay
 * out, is a re-run a no-op, is anything merged) is in
 * `ObjectDuplicateDetectStage.integration.spec.ts`, against real Postgres —
 * `ObjectDuplicateService`'s grouping is 90 lines of SQL and a mock that
 * answers it would be asserting this file's own fixtures.
 */

const ITEM_A = '00000000-0000-4000-8000-0000000000a1';
const ITEM_B = '00000000-0000-4000-8000-0000000000b2';
const ITEM_C = '00000000-0000-4000-8000-0000000000c3';

function group(reason: ObjectDuplicateReason, value: string, ids: string[]): ObjectDuplicateGroup {
  return {
    reason,
    value,
    items: ids.map((id) => ({ id }) as Item),
    totalItems: ids.length,
  };
}

describe('the version', () => {
  it('is a positive integer, as versions.ts requires', () => {
    expect(Number.isInteger(OBJECT_DUPLICATE_DETECT_VERSION)).toBe(true);
    expect(OBJECT_DUPLICATE_DETECT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('accepts a STAGE_VERSIONS map with no entry for it yet', () => {
    expect(objectDuplicateDetectStageVersion({})).toBe(OBJECT_DUPLICATE_DETECT_VERSION);
  });

  it('throws when versions.ts disagrees, naming both numbers', () => {
    expect(() =>
      objectDuplicateDetectStageVersion({
        [CLEAN_OBJECT_DUPLICATE_DETECT_STAGE_ID]: OBJECT_DUPLICATE_DETECT_VERSION + 5,
      }),
    ).toThrow(/update versions\.ts in the same commit/);
  });
});

describe('the candidate set', () => {
  /**
   * THE ONE RULE, for this stage. The predicate states what a row IS; the
   * ledger states whether the stage has run. Mentioning `ci.merge_candidates`
   * here would put this stage's own output back into its candidate selection —
   * a unit would leave the set the moment one pair was proposed for it, and no
   * rescoring bump could ever reach it again.
   */
  it('never mentions the table it writes', () => {
    expect(OBJECT_DUPLICATE_DETECT_SOURCE.predicate).not.toContain('merge_candidates');
  });

  it('never consults the ledger — that is the sweep’s job, not the predicate’s', () => {
    expect(OBJECT_DUPLICATE_DETECT_SOURCE.predicate).not.toMatch(/pipeline_state|\bp\./);
  });

  it('sweeps owned units, keyed and scoped by the columns ci.objects actually has', () => {
    expect(OBJECT_DUPLICATE_DETECT_SOURCE.schema).toBe('ci');
    expect(OBJECT_DUPLICATE_DETECT_SOURCE.table).toBe('objects');
    expect(OBJECT_DUPLICATE_DETECT_SOURCE.idColumn).toBe('object_id');
    expect(OBJECT_DUPLICATE_DETECT_SOURCE.userColumn).toBe('user_id');
  });
});

describe('the scoring rule', () => {
  it('scores every reason the detector can produce, and nothing else', () => {
    expect(Object.keys(OBJECT_REASON_SCORES).sort()).toEqual(['brand_model', 'identifier', 'product_name']);
  });

  it('keeps every score inside the range ci.merge_candidates CHECKs', () => {
    for (const score of Object.values(OBJECT_REASON_SCORES)) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(score).toBeGreaterThanOrEqual(MIN_OBJECT_CANDIDATE_SCORE);
    }
  });

  /**
   * The calibration that matters. Owning two of the same product is ordinary,
   * so a shared code can never be worth what a shared mailbox is worth on the
   * person side — the identifier rung cannot tell a serial from a UPC.
   */
  it('ranks identifier above product above brand+model, all below the person tier', () => {
    expect(OBJECT_REASON_SCORES.identifier).toBeGreaterThan(OBJECT_REASON_SCORES.product_name);
    expect(OBJECT_REASON_SCORES.product_name).toBeGreaterThan(OBJECT_REASON_SCORES.brand_model);
    expect(OBJECT_REASON_SCORES.identifier).toBeLessThan(0.95);
  });
});

describe('buildObjectCandidates', () => {
  it('turns a group of n into n(n-1)/2 ordered pairs', () => {
    const candidates = buildObjectCandidates([
      group('brand_model', 'acme|x1|2026-01-02', [ITEM_C, ITEM_A, ITEM_B]),
    ]);

    expect(candidates).toHaveLength(3);

    for (const candidate of candidates) {
      expect(candidate.entityIdA < candidate.entityIdB).toBe(true);
      expect(candidate.score).toBe(OBJECT_REASON_SCORES.brand_model);
    }
  });

  /**
   * THE REGRESSION THIS PINS. Two units that share a barcode almost always
   * share brand+model too, and the detector only suppresses a weaker group
   * whose member set is IDENTICAL to a stronger one — so {A,B} by identifier
   * and {A,B,C} by brand+model both survive, and both contain the pair (A,B).
   * Two rows for one pair in a single `INSERT ... ON CONFLICT DO UPDATE` is not
   * a duplicate row, it is `ON CONFLICT DO UPDATE command cannot affect row a
   * second time`, and it fails the whole slice.
   */
  it('emits one candidate per pair even when two groups contain it', () => {
    const candidates = buildObjectCandidates([
      group('identifier', 'B00ABCDEF1', [ITEM_A, ITEM_B]),
      group('brand_model', 'acme|x1|2026-01-02', [ITEM_A, ITEM_B, ITEM_C]),
    ]);

    const keys = candidates.map((candidate) => `${candidate.entityIdA}|${candidate.entityIdB}`);

    expect(new Set(keys).size).toBe(keys.length);
    expect(candidates).toHaveLength(3);
  });

  it('scores a corroborated pair at the MAXIMUM of its reasons, never their sum', () => {
    const [pair] = buildObjectCandidates([
      group('brand_model', 'acme|x1|2026-01-02', [ITEM_A, ITEM_B]),
      group('identifier', 'B00ABCDEF1', [ITEM_A, ITEM_B]),
    ]);

    expect(pair.score).toBe(OBJECT_REASON_SCORES.identifier);
    expect(pair.score).toBeLessThanOrEqual(1);
  });

  it('keeps every reason as evidence, strongest first — the evidence is what a reviewer reads', () => {
    const [pair] = buildObjectCandidates([
      group('brand_model', 'acme|x1|2026-01-02', [ITEM_A, ITEM_B]),
      group('identifier', 'B00ABCDEF1', [ITEM_A, ITEM_B]),
    ]);

    expect(pair.evidence).toEqual([
      { kind: 'identifier', value: 'B00ABCDEF1', score: OBJECT_REASON_SCORES.identifier },
      { kind: 'brand_model', value: 'acme|x1|2026-01-02', score: OBJECT_REASON_SCORES.brand_model },
    ]);
  });

  it('ignores a reason nobody has calibrated rather than inventing a weight for it', () => {
    expect(
      buildObjectCandidates([group('handwave' as ObjectDuplicateReason, 'x', [ITEM_A, ITEM_B])]),
    ).toEqual([]);
  });

  it('proposes nothing for a group the block filter has cut down to one member', () => {
    expect(buildObjectCandidates([group('identifier', 'B00ABCDEF1', [ITEM_A])])).toEqual([]);
  });
});
