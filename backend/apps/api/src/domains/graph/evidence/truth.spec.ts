import { type TruthValue, c2w, expectation, revise, w2c } from './truth';

/** A spread of weights that covers "one observation" through "a real corpus". */
const WEIGHTS = [0, 0.5, 1, 2, 3, 5, 10, 42, 99, 1000, 1e6];
/** Confidences chosen to sit inside `[0, 1)`, including both ends of the useful band. */
const CONFIDENCES = [0, 0.01, 0.1, 0.25, 1 / 3, 0.5, 0.75, 0.9, 0.99, 0.999];
const FREQUENCIES = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

/**
 * Relative closeness. `toBeCloseTo` compares an ABSOLUTE difference, which is
 * meaningless once a weight is 1e6 — a round trip through two divisions is
 * exact to ~1e-10 relative and nowhere near 5e-7 absolute.
 */
function expectRelativelyClose(actual: number, expected: number, relative = 1e-9): void {
  const scale = Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected) / scale).toBeLessThan(relative);
}

describe('c2w / w2c', () => {
  it('are exact inverses in both directions (the whole point of the module)', () => {
    for (const w of WEIGHTS) {
      expectRelativelyClose(c2w(w2c(w)), w);
    }

    for (const c of CONFIDENCES) {
      expect(w2c(c2w(c))).toBeCloseTo(c, 12);
    }
  });

  it('pins the reference points', () => {
    expect(w2c(0)).toBe(0);
    expect(w2c(1)).toBe(0.5);
    expect(w2c(3)).toBeCloseTo(0.75, 12);
    expect(c2w(0)).toBe(0);
    expect(c2w(0.5)).toBe(1);
    expect(c2w(0.75)).toBeCloseTo(3, 12);
  });

  it('w2c never reaches 1 — no finite corpus closes a question', () => {
    for (const w of WEIGHTS) {
      expect(w2c(w)).toBeLessThan(1);
      expect(w2c(w)).toBeGreaterThanOrEqual(0);
    }

    expect(w2c(1e15)).toBeLessThan(1);
  });

  it('both are strictly increasing, so more evidence never reads as less', () => {
    for (let i = 1; i < WEIGHTS.length; i++) {
      expect(w2c(WEIGHTS[i])).toBeGreaterThan(w2c(WEIGHTS[i - 1]));
    }

    for (let i = 1; i < CONFIDENCES.length; i++) {
      expect(c2w(CONFIDENCES[i])).toBeGreaterThan(c2w(CONFIDENCES[i - 1]));
    }
  });

  it('rejects a confidence of exactly 1 rather than returning Infinity', () => {
    // An infinite weight would make every later revise() produce NaN
    // frequencies (Infinity * f / Infinity), so it is refused at the door.
    expect(() => c2w(1)).toThrow(RangeError);
    expect(() => c2w(1.5)).toThrow(RangeError);
    expect(() => c2w(-0.1)).toThrow(RangeError);
    expect(() => c2w(Number.NaN)).toThrow(RangeError);
    expect(() => c2w(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('rejects a negative or non-finite weight', () => {
    expect(() => w2c(-1)).toThrow(RangeError);
    expect(() => w2c(Number.NaN)).toThrow(RangeError);
    expect(() => w2c(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('revise', () => {
  it('pools evidence weights exactly — the property that removes the full recount', () => {
    for (const wa of WEIGHTS) {
      for (const wb of WEIGHTS) {
        const revised = revise({ frequency: 1, confidence: w2c(wa) }, { frequency: 1, confidence: w2c(wb) });
        expectRelativelyClose(c2w(revised.confidence), wa + wb);
      }
    }
  });

  it('absorbs one new observation in O(1): five visits then one more is six', () => {
    // The FREQUENTS pathology, stated as arithmetic. Today a sixth visit-day
    // requires recounting ci.position from scratch; here it is +1 weight.
    const fiveDays: TruthValue = { frequency: 1, confidence: w2c(5) };
    const oneMore: TruthValue = { frequency: 1, confidence: w2c(1) };
    const sixDays = revise(fiveDays, oneMore);

    expect(c2w(sixDays.confidence)).toBeCloseTo(6, 9);
    expect(sixDays.confidence).toBeCloseTo(w2c(6), 12);
    expect(sixDays.frequency).toBeCloseTo(1, 12);
  });

  it('is commutative', () => {
    const cases: Array<[TruthValue, TruthValue]> = [
      [
        { frequency: 1, confidence: w2c(3) },
        { frequency: 0, confidence: w2c(1) },
      ],
      [
        { frequency: 0.25, confidence: 0.9 },
        { frequency: 0.75, confidence: 0.1 },
      ],
      [
        { frequency: 0.5, confidence: 0 },
        { frequency: 1, confidence: 0.5 },
      ],
    ];
    for (const [a, b] of cases) {
      expect(revise(a, b)).toStrictEqual(revise(b, a));
    }
  });

  it('is associative in pooled weight across three observations', () => {
    const a: TruthValue = { frequency: 1, confidence: w2c(2) };
    const b: TruthValue = { frequency: 0, confidence: w2c(3) };
    const c: TruthValue = { frequency: 1, confidence: w2c(5) };

    const left = revise(revise(a, b), c);
    const right = revise(a, revise(b, c));

    expectRelativelyClose(c2w(left.confidence), 10);
    expectRelativelyClose(c2w(right.confidence), 10);
    expect(left.frequency).toBeCloseTo(right.frequency, 9);
    // Weight-weighted: 7 of the 10 units of evidence say "yes".
    expect(left.frequency).toBeCloseTo(0.7, 9);
  });

  it('is monotone in confidence — evidence never subtracts certainty', () => {
    for (const ca of CONFIDENCES) {
      for (const cb of CONFIDENCES) {
        const revised = revise({ frequency: 0.3, confidence: ca }, { frequency: 0.8, confidence: cb });
        expect(revised.confidence).toBeGreaterThanOrEqual(Math.max(ca, cb) - 1e-12);
        expect(revised.confidence).toBeLessThan(1);
      }
    }
  });

  it('weights the frequency by evidence, not by argument position', () => {
    // Nine observations of "yes" against one of "no" must land near 0.9, and
    // the plain average (0.5) must NOT be the answer.
    const revised = revise({ frequency: 1, confidence: w2c(9) }, { frequency: 0, confidence: w2c(1) });
    expect(revised.frequency).toBeCloseTo(0.9, 9);
    expect(revised.frequency).not.toBeCloseTo(0.5, 2);
  });

  it('leaves the frequency between the two inputs', () => {
    for (const fa of FREQUENCIES) {
      for (const fb of FREQUENCIES) {
        const revised = revise({ frequency: fa, confidence: 0.6 }, { frequency: fb, confidence: 0.2 });
        expect(revised.frequency).toBeGreaterThanOrEqual(Math.min(fa, fb) - 1e-12);
        expect(revised.frequency).toBeLessThanOrEqual(Math.max(fa, fb) + 1e-12);
      }
    }
  });

  it('treats a zero-confidence input as the identity', () => {
    const evidence: TruthValue = { frequency: 0.8, confidence: w2c(4) };
    const nothing: TruthValue = { frequency: 0.1, confidence: 0 };

    const revised = revise(evidence, nothing);
    expect(revised.frequency).toBeCloseTo(0.8, 12);
    expect(revised.confidence).toBeCloseTo(evidence.confidence, 12);
  });

  it('stays total when both sides carry no evidence at all', () => {
    const revised = revise({ frequency: 1, confidence: 0 }, { frequency: 0, confidence: 0 });
    expect(revised).toStrictEqual({ frequency: 0.5, confidence: 0 });
    expect(Number.isNaN(revised.frequency)).toBe(false);
    // Inert either way: at c = 0 the expectation is 0.5 for every frequency.
    expect(expectation(revised.frequency, revised.confidence)).toBe(0.5);
  });

  it('double-counting the SAME observation is not a no-op — dedupe before revising', () => {
    // The live hazard: importers re-read the same Takeout corpus. Revision is
    // additive by design, so a re-import inflates the weight without bound.
    // This test documents the failure mode rather than defending against it;
    // the caller must key on a provenance triple (see the module header).
    const once: TruthValue = { frequency: 1, confidence: w2c(1) };
    const twice = revise(once, once);
    expect(c2w(twice.confidence)).toBeCloseTo(2, 12);

    let accumulated = once;
    for (let i = 0; i < 999; i++) {
      accumulated = revise(accumulated, once);
    }

    expectRelativelyClose(c2w(accumulated.confidence), 1000, 1e-9);
    expect(accumulated.confidence).toBeGreaterThan(0.999);
  });

  it('rejects out-of-range inputs on either side', () => {
    const ok: TruthValue = { frequency: 0.5, confidence: 0.5 };
    expect(() => revise({ frequency: 1.2, confidence: 0.5 }, ok)).toThrow(RangeError);
    expect(() => revise(ok, { frequency: -0.1, confidence: 0.5 })).toThrow(RangeError);
    expect(() => revise({ frequency: 0.5, confidence: 1 }, ok)).toThrow(RangeError);
    expect(() => revise(ok, { frequency: Number.NaN, confidence: 0.5 })).toThrow(RangeError);
  });
});

describe('expectation', () => {
  it('pins the reference points', () => {
    expect(expectation(1, 0)).toBe(0.5);
    expect(expectation(0, 0)).toBe(0.5);
    expect(expectation(1, 0.5)).toBe(0.75);
    expect(expectation(0, 0.5)).toBe(0.25);
    expect(expectation(0.5, 0.99)).toBe(0.5);
  });

  it('pulls the frequency toward 0.5 in proportion to missing evidence', () => {
    for (const f of FREQUENCIES) {
      let previousDistance = Number.POSITIVE_INFINITY;
      for (const c of [...CONFIDENCES].reverse()) {
        const distance = Math.abs(expectation(f, c) - 0.5);
        expect(distance).toBeLessThanOrEqual(previousDistance + 1e-12);
        expect(distance).toBeLessThanOrEqual(Math.abs(f - 0.5) + 1e-12);
        previousDistance = distance;
      }
    }
  });

  it('ranks a hundred observations above one, which raw frequency cannot', () => {
    const once = expectation(1, w2c(1));
    const hundred = expectation(1, w2c(100));
    expect(once).toBeCloseTo(0.75, 12);
    expect(hundred).toBeGreaterThan(once);
    expect(hundred).toBeCloseTo(0.5 + 0.5 * (100 / 101), 12);
  });

  it('stays strictly inside (0, 1) for every valid truth value', () => {
    for (const f of FREQUENCIES) {
      for (const c of CONFIDENCES) {
        const e = expectation(f, c);
        expect(e).toBeGreaterThan(0);
        expect(e).toBeLessThan(1);
      }
    }
  });

  it('is NOT on the scale of the current ci.relationships.strength', () => {
    // The seductive-and-false claim, nailed down as a test so nobody swaps the
    // column over believing readers are untouched. 5 visit-days:
    //   today   LN(6)/LN(10)/2      = 0.389
    //   algebra 0.5 + 0.5 * w2c(5)  = 0.917
    const todaysFrequentsStrength = Math.log(5 + 1) / Math.log(10) / 2;
    const algebraic = expectation(1, w2c(5));

    expect(todaysFrequentsStrength).toBeCloseTo(0.389, 3);
    expect(algebraic).toBeCloseTo(0.9167, 4);
    expect(Math.abs(algebraic - todaysFrequentsStrength)).toBeGreaterThan(0.5);

    // And the curves are not the same shape: the log formula saturates at
    // n = 99 while w2c never reaches 1.
    expect(Math.min(1, Math.log(99 + 1) / Math.log(10) / 2)).toBe(1);
    expect(w2c(99)).toBeLessThan(1);
  });

  it('rejects out-of-range inputs', () => {
    expect(() => expectation(1.5, 0.5)).toThrow(RangeError);
    expect(() => expectation(0.5, 1)).toThrow(RangeError);
    expect(() => expectation(Number.NaN, 0.5)).toThrow(RangeError);
    expect(() => expectation(0.5, -0.2)).toThrow(RangeError);
  });
});
