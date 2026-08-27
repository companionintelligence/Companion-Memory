/**
 * An **invertible evidence algebra** for graph edge strength — the NAL truth
 * value `(frequency, confidence)` and the two conversions that make evidence
 * accumulate instead of being recomputed.
 *
 * ## Why this module exists
 *
 * This repo has independently invented an edge-strength curve three times, and
 * none of the three is invertible, so no observation can ever be *added* to
 * what an edge already knows:
 *
 *  - `maintenance/services/DerivedRelationshipService.ts` (~:226) —
 *    `GREATEST(LEAST(1.0, LN(link_kinds + 1) / LN(10) / 2.0),
 *              LEAST(1.0, LN(exchanged + 1) / LN($4)))` for `COMMUNICATES_WITH`;
 *  - the same file (~:335) — `LEAST(1.0, LN(n + 1) / LN(10) / 2.0)` over
 *    distinct visit days for `FREQUENTS`;
 *  - `llm/inferredAnswerConfidence.ts` (~:271-288) —
 *    `min(relatedAnswerCount, 6) * 0.07 + min(memoryEvidenceCount, 10) * 0.05`,
 *    clamped linear, combined with the model's own score by `min()`.
 *
 * Each maps *a count* to a number in `[0, 1]`. None maps back. Given a stored
 * `strength` of `0.389` there is no way to recover "5 visit-days", so a sixth
 * visit cannot be folded in — the only way to move the number is to **recount
 * the whole corpus**. That is exactly what both derived legs do, and the
 * `FREQUENTS` JSDoc (~:279-293) documents the pathology on itself: repeat
 * evidence is not countable from `ci.relationships` because
 * `relationships_unique_directed_idx` keeps at most one active row per
 * `(from, to, type)`, and new observations arrive through
 * `GraphIngestService.ts` (~:631) as
 * `ON CONFLICT (...) WHERE is_active = TRUE DO NOTHING` — a repeat observation
 * adds literally nothing.
 *
 * `c2w`/`w2c` are exact inverses over their domain, so an edge that stores its
 * evidence *weight* can absorb one new observation in O(1): `w' = w + 1`. There
 * is no full recount because there is nothing to recount.
 *
 * ## The algebra
 *
 * A truth value is a pair:
 *
 *  - **frequency** `f ∈ [0, 1]` — of the evidence seen, what proportion was
 *    positive. "Did they in fact communicate", not "how much".
 *  - **confidence** `c ∈ [0, 1)` — how much evidence is behind that frequency,
 *    expressed as a bounded proxy for an unbounded weight. Never reaches 1:
 *    no finite amount of evidence closes a question.
 *
 * `c2w(c) = c / (1 - c)` opens the bound; `w2c(w) = w / (w + 1)` closes it
 * again. Weight is the additive quantity; confidence is the reportable one.
 *
 * {@link revise} is the combination operator the codebase currently lacks
 * entirely: pool the weights, take the weight-weighted mean of the frequencies.
 * {@link expectation} projects a truth value onto a single decision number.
 *
 * ## This module has NO callers on purpose
 *
 * Normally a producer-less module is precisely the defect this work exists to
 * remove, so the exception is stated out loud: **nothing here is wired to
 * `ci.relationships.strength`, and switching `strength` over is deliberately
 * out of scope.** The tempting claim — "leave `strength` as
 * `expectation(frequency, w2c(evidence_w))` and every current reader is
 * untouched" — is false. `expectation` ranges `[0.5, 1)` at `f = 1`, while
 * today's strengths span `[0, 1]`; a `FREQUENTS` edge at 5 visit-days is
 * `LN(6)/LN(10)/2 = 0.389` today and would become `0.5 + 0.5 * w2c(5) = 0.917`.
 * The curves are not even the same shape: `LN(n+1)/LN(10)/2` reaches `1.0` at
 * `n = 99`, `w2c` never reaches `1`. Every reader that thresholds or orders on
 * `strength` — `memory/services/KnownPlacesService.ts` (~:27 `confidence =
 * relationship.strength`, ~:286 `ORDER BY r.strength DESC`),
 * `memory/services/GraphUtilityService.ts` (~:482),
 * `graph/services/GraphExpansionService.ts` (~:330),
 * `relationships_strength_idx`, and the graph explorer — would see materially
 * different numbers. That is a value-changing migration needing a backfill and
 * a full reader audit, and it is not this change.
 *
 * The follow-up that consumes this module: add `frequency` / `evidence_w`
 * columns to `ci.relationships`, have the derived legs and `GraphIngestService`
 * write them through {@link revise} while `strength` keeps its exact current
 * formula, verify the two agree in ordering on a real corpus, and only then
 * migrate readers.
 *
 * ## Independence — the live double-counting hazard
 *
 * {@link revise} assumes its two arguments are **independent** evidence. They
 * are not, by default, in this repo: importers re-read the same Google Takeout
 * corpus, so the same message can be observed many times. Weight is additive
 * and unbounded, so a re-import inflates `evidence_w` without bound and the
 * edge asymptotically claims certainty it never earned. Nothing in this module
 * can detect that — it sees two numbers, not their provenance.
 *
 * The caller must therefore dedupe **before** revising, keyed on a provenance
 * triple, exactly the discipline `ci.identifier_claims` already established
 * with its `UNIQUE (owner_user_id, subject_type, subject_id, role, kind,
 * value_normalized)` (`db/postgres/migrations/20260809183010_identifier_claims.sql`
 * ~:41). Revise once per distinct `(source, observation_id, edge)`, never once
 * per row read.
 */

/**
 * An amount of evidence and what it says.
 *
 * Both fields are validated at every entry point in this module; construct one
 * from arbitrary input by passing it through {@link revise} or by checking it
 * yourself. A stored `evidence_w` should be converted with {@link w2c} rather
 * than persisted as a confidence, because weight is the field that survives
 * addition.
 */
export interface TruthValue {
  /** Proportion of the evidence that was positive. `[0, 1]`. */
  frequency: number;
  /** Bounded proxy for the evidence weight. `[0, 1)` — never exactly 1. */
  confidence: number;
}

function assertFrequency(f: number, label: string): void {
  if (!Number.isFinite(f) || f < 0 || f > 1) {
    throw new RangeError(`${label} must be a finite frequency in [0, 1]; got ${f}`);
  }
}

/**
 * Confidence → evidence weight. `c2w(c) = c / (1 - c)`.
 *
 * The inverse of {@link w2c}. Opens the bounded confidence back into the
 * unbounded, **additive** quantity: `c2w(w2c(3)) === 3`, so three observations
 * plus two more is five, not "0.75 combined somehow with 0.667".
 *
 * `c = 1` is rejected rather than returning `Infinity`. A confidence of exactly
 * 1 means infinite evidence, which no finite corpus produces; accepting it here
 * would let one poisoned input make every subsequent {@link revise} return
 * `NaN` frequencies (`Infinity * f / Infinity`). Confidence is `[0, 1)`.
 *
 * @param c Confidence in `[0, 1)`.
 * @returns Evidence weight in `[0, ∞)`.
 * @throws RangeError if `c` is not finite, is negative, or is `>= 1`.
 */
export function c2w(c: number): number {
  if (!Number.isFinite(c) || c < 0 || c >= 1) {
    throw new RangeError(`confidence must be a finite value in [0, 1); got ${c}`);
  }

  return c / (1 - c);
}

/**
 * Evidence weight → confidence. `w2c(w) = w / (w + 1)`.
 *
 * The inverse of {@link c2w}. Note what the shape buys: the first observation
 * is worth `0.5`, the tenth moves the number by `0.008`, and no finite `w`
 * reaches `1`. Diminishing returns are structural rather than a hand-tuned
 * `LEAST(1.0, ...)` cap — which is what all three existing curves needed, and
 * what makes them non-invertible above the cap (every `n >= 99` maps to `1.0`
 * in the `FREQUENTS` formula).
 *
 * @param w Evidence weight in `[0, ∞)`.
 * @returns Confidence in `[0, 1)`.
 * @throws RangeError if `w` is not finite or is negative.
 */
export function w2c(w: number): number {
  if (!Number.isFinite(w) || w < 0) {
    throw new RangeError(`evidence weight must be a finite value in [0, ∞); got ${w}`);
  }

  return w / (w + 1);
}

/**
 * The combination operator: fold two independent truth values into one.
 *
 * Pool the evidence weights, then take the **weight-weighted mean** of the
 * frequencies, so the side with more evidence behind it moves the result more:
 *
 * ```
 * w  = c2w(a.confidence) + c2w(b.confidence)
 * f  = (c2w(a.confidence) * a.frequency + c2w(b.confidence) * b.frequency) / w
 * c  = w2c(w)
 * ```
 *
 * Two consequences worth naming, both covered by tests:
 *
 *  - **Commutative.** `revise(a, b)` equals `revise(b, a)`. Evidence order does
 *    not matter, which is what lets a nightly job and a live ingest write into
 *    the same edge without racing for a different answer.
 *  - **Monotone in pooled weight.** The result's confidence is `>=` both
 *    inputs' — adding evidence never makes an edge less certain, only moves its
 *    frequency. This is the property that `ON CONFLICT DO NOTHING` denies today
 *    and that `strength = EXCLUDED.strength` (a full overwrite from a recount)
 *    only accidentally satisfies.
 *
 * **Read the independence warning in the module header before calling this.**
 * Revising the same observation twice is not a no-op; it doubles its weight.
 *
 * The degenerate case — both inputs at confidence `0`, i.e. no evidence at all
 * on either side — has no weighted mean to take (`0/0`). It returns the plain
 * arithmetic mean of the frequencies at confidence `0`, which keeps the
 * operator commutative and total. The value is inert either way: at `c = 0`,
 * {@link expectation} is `0.5` for every frequency.
 *
 * @throws RangeError if either frequency is outside `[0, 1]` or either
 *   confidence is outside `[0, 1)`.
 */
export function revise(a: TruthValue, b: TruthValue): TruthValue {
  assertFrequency(a.frequency, 'a.frequency');
  assertFrequency(b.frequency, 'b.frequency');

  const wa = c2w(a.confidence);
  const wb = c2w(b.confidence);
  const w = wa + wb;

  if (w === 0) {
    return { frequency: (a.frequency + b.frequency) / 2, confidence: 0 };
  }

  return { frequency: (wa * a.frequency + wb * b.frequency) / w, confidence: w2c(w) };
}

/**
 * Project a truth value onto one decision number:
 * `expectation(f, c) = c * (f - 0.5) + 0.5`.
 *
 * Confidence pulls the frequency toward `0.5` — "no idea" — in proportion to
 * how little evidence stands behind it. This is the number to rank or threshold
 * on, because it refuses to let a single observation of a thing that happened
 * (`f = 1, c = 0.5` → `0.75`) outrank a hundred (`f = 1, c ≈ 0.99` → `0.995`),
 * which raw frequency does.
 *
 * Range is `(0, 1)`: `[0.5, 1)` for `f = 1`, `(0, 0.5]` for `f = 0`. **It is
 * not on the same scale as today's `ci.relationships.strength`** — see the
 * module header. Nothing here writes that column.
 *
 * @throws RangeError if `frequency` is outside `[0, 1]` or `confidence` is
 *   outside `[0, 1)`.
 */
export function expectation(frequency: number, confidence: number): number {
  assertFrequency(frequency, 'frequency');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence >= 1) {
    throw new RangeError(`confidence must be a finite value in [0, 1); got ${confidence}`);
  }

  return confidence * (frequency - 0.5) + 0.5;
}
