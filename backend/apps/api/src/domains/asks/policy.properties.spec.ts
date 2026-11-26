import {
  DISCLOSURE_RUNGS,
  applyDisclosureCeiling,
  minRung,
  narrowerForm,
  narrowestRung,
  rungAtLeast,
  rungForForm,
} from './policy';
import type { AnswerForm, DisclosedAnswer, DisclosedItem, DisclosureRung } from './types';

/**
 * The `//@` contracts in policy.ts, checked against the real functions.
 *
 * LemmaScript proves them (spec/lemmascript) about a model in which numbers are mathematical
 * integers, strings are sequences of Unicode scalars, and a string union has only its members.
 * JavaScript has NaN, Infinity, -0, doubles past 2^53, lone surrogates and jsonb strings that
 * name nothing. Each block below restates a contract and runs it over those values too, either
 * exhaustively (the rung and form domains are small) or with a seeded generator, so a gap between
 * the model and the runtime fails here rather than in production.
 */

/** A small seeded PRNG (mulberry32) so a failure is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

const RUNGS = DISCLOSURE_RUNGS;
const FORMS: readonly AnswerForm[] = ['boolean', 'existence', 'attribute', 'retrieval', 'identity'];

/** The reference order: a rung's place on the documented ladder. */
const place = (rung: DisclosureRung): number => RUNGS.indexOf(rung);

/** Strings a jsonb column could hold that name no rung, including Object.prototype keys. */
const NOT_RUNGS = ['', 'summry', 'FULL', ' full', 'none ', '__proto__', 'constructor', 'toString'];

/** Counts the model cannot represent, beside ordinary ones. */
const COUNTS = [0, 1, 2, 7, -3, -0, 1.5, 2 ** 53 + 2, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity];

/** Text with the shapes the Unicode-scalar model treats differently from UTF-16. */
const TEXTS = [
  'They shared 2 items.',
  '',
  '\ud83d\ude00 astral',
  'lone \ud800 surrogate',
  'e\u0301',
  '\uffff',
];

function randomItems(random: () => number): DisclosedItem[] {
  return Array.from({ length: Math.floor(random() * 4) }, (_, index) => ({
    id: `${pick(random, TEXTS)}-${index}`,
    type: pick(random, ['file', 'event', 'note']),
  }));
}

function randomAnswer(random: () => number): DisclosedAnswer {
  return {
    form: pick(random, FORMS),
    items: randomItems(random),
    disclosedCount: pick(random, COUNTS),
    withheldCount: pick(random, COUNTS),
    summary: pick(random, TEXTS),
    consentBasis: random() < 0.5 ? null : pick(random, ['grant-1', '\ud83d\ude00']),
  };
}

describe('rungIndex, rungAtLeast and minRung: the ladder is a total order', () => {
  it('agrees with DISCLOSURE_RUNGS on every pair', () => {
    for (const a of RUNGS) {
      for (const b of RUNGS) {
        expect(rungAtLeast(a, b)).toBe(place(a) >= place(b));
        expect(minRung(a, b)).toBe(place(a) <= place(b) ? a : b);
      }
    }
  });

  it('is reflexive, total, antisymmetric and transitive', () => {
    for (const a of RUNGS) {
      expect(rungAtLeast(a, a)).toBe(true);

      for (const b of RUNGS) {
        expect(rungAtLeast(a, b) || rungAtLeast(b, a)).toBe(true);

        if (rungAtLeast(a, b) && rungAtLeast(b, a)) {
          expect(a).toBe(b);
        }

        for (const c of RUNGS) {
          if (rungAtLeast(a, b) && rungAtLeast(b, c)) {
            expect(rungAtLeast(a, c)).toBe(true);
          }
        }
      }
    }
  });

  it('makes minRung the meet: one of its arguments, below both, and the greatest such rung', () => {
    for (const a of RUNGS) {
      for (const b of RUNGS) {
        const m = minRung(a, b);

        expect([a, b]).toContain(m);
        expect(rungAtLeast(a, m) && rungAtLeast(b, m)).toBe(true);
        expect(minRung(b, a)).toBe(m);

        for (const c of RUNGS) {
          if (rungAtLeast(a, c) && rungAtLeast(b, c)) {
            expect(rungAtLeast(m, c)).toBe(true);
          }
        }
      }
    }
  });

  // Outside the model: a jsonb string that names no rung. The old lookup table compared it
  // `false` both ways, and the spelled-out index keeps that.
  it('compares a string that names no rung as false in both directions', () => {
    for (const bogus of NOT_RUNGS as DisclosureRung[]) {
      for (const rung of RUNGS) {
        expect(rungAtLeast(bogus, rung)).toBe(false);
        expect(rungAtLeast(rung, bogus)).toBe(false);
        expect([bogus, rung]).toContain(minRung(bogus, rung));
        expect([bogus, rung]).toContain(minRung(rung, bogus));
      }
    }
  });
});

describe('narrowestRung: a source that names a ceiling is never erased', () => {
  const SOURCES: (DisclosureRung | null | undefined)[] = [...RUNGS, null, undefined];

  it('holds every contract clause on every pair of sources, null and undefined included', () => {
    for (const a of SOURCES) {
      for (const b of SOURCES) {
        const result = narrowestRung(a, b);

        if (a == null && b == null) {
          expect(result).toBeUndefined();
          continue;
        }

        expect(result).toBeDefined();
        const r = result as DisclosureRung;

        expect((a != null && r === a) || (b != null && r === b)).toBe(true);

        if (a != null) {
          expect(rungAtLeast(a, r)).toBe(true);
        }

        if (b != null) {
          expect(rungAtLeast(b, r)).toBe(true);
        }

        for (const c of RUNGS) {
          if ((a == null || rungAtLeast(a, c)) && (b == null || rungAtLeast(b, c))) {
            expect(rungAtLeast(r, c)).toBe(true);
          }
        }
      }
    }
  });

  /**
   * The revocation case the function exists for: the stamped ceiling `s` stays, the live one
   * changes or disappears. Whatever the live source does, the result stays at or below `s`.
   */
  it('keeps the stamped ceiling as an upper bound whatever the live source does', () => {
    for (const stamped of RUNGS) {
      for (const live of SOURCES) {
        expect(rungAtLeast(stamped, narrowestRung(stamped, live) as DisclosureRung)).toBe(true);
      }
    }
  });
});

describe('rungForForm and narrowerForm', () => {
  it('gives only retrieval a rung that can carry item references', () => {
    for (const form of FORMS) {
      expect(rungAtLeast(rungForForm(form), 'redacted')).toBe(form === 'retrieval');
    }

    expect(rungForForm('retrieval')).toBe('full');
  });

  it('puts each form on the rung its contract names', () => {
    expect(Object.fromEntries(FORMS.map((form) => [form, rungForForm(form)]))).toEqual({
      boolean: 'boolean',
      identity: 'boolean',
      existence: 'count',
      attribute: 'summary',
      retrieval: 'full',
    });
  });

  it('never takes the wider form, and gives a tie to the owner', () => {
    for (const chosen of FORMS) {
      for (const inferred of FORMS) {
        const result = narrowerForm(chosen, inferred);

        expect([chosen, inferred]).toContain(result);
        expect(rungAtLeast(rungForForm(chosen), rungForForm(result))).toBe(true);
        expect(rungAtLeast(rungForForm(inferred), rungForForm(result))).toBe(true);

        if (rungAtLeast(rungForForm(inferred), rungForForm(chosen))) {
          expect(result).toBe(chosen);
        }
      }
    }
  });
});

describe('applyDisclosureCeiling: the ask clamp', () => {
  const CASES = 2000;

  /**
   * "The same number" in the contract is Dafny's integer equality. JavaScript's `===` is false
   * for NaN against itself, so the runtime check uses Object.is, which also tells -0 from 0.
   */
  const same = (x: number, y: number): boolean => Object.is(x, y);

  /** `countOnlySummary`, restated: the sentence the count rung writes. */
  const countSentence = (count: number): string =>
    count === 1 ? '1 matching item.' : `${count} matching items.`;

  it('holds every contract clause, seed 1', () => {
    const random = prng(1);

    for (let i = 0; i < CASES; i++) {
      const answer = randomAnswer(random);
      const ceiling = pick(random, RUNGS);
      const result = applyDisclosureCeiling(answer, ceiling);
      const natural = rungForForm(answer.form);
      const effective = minRung(natural, ceiling);

      expect(result.form).toBe(answer.form);
      expect(result.consentBasis).toBe(answer.consentBasis);

      if (rungAtLeast(natural, 'full') && rungAtLeast(ceiling, 'full')) {
        expect(result).toBe(answer);
      }

      if (!rungAtLeast(ceiling, 'full') || !rungAtLeast(natural, 'full')) {
        expect(result.withheldCount).toBe(0);
      }

      if (!rungAtLeast(ceiling, 'redacted') || !rungAtLeast(natural, 'redacted')) {
        expect(result.items).toEqual([]);
      }

      if (!rungAtLeast(ceiling, 'count') || !rungAtLeast(natural, 'count')) {
        expect([0, 1]).toContain(result.disclosedCount);
      }

      if (ceiling === 'none') {
        expect(result.disclosedCount).toBe(0);
        expect(result.summary).toBe('Nothing was shared.');
      }

      if (effective === 'count') {
        expect(result.summary).toBe(countSentence(answer.disclosedCount));
      }

      if (effective === 'boolean') {
        expect(result.disclosedCount).toBe(answer.disclosedCount > 0 ? 1 : 0);
        expect(result.summary).toBe(answer.disclosedCount > 0 ? 'Yes.' : 'No.');
      }

      expect(result.items.length === 0 || result.items === answer.items).toBe(true);
      expect(same(result.withheldCount, 0) || same(result.withheldCount, answer.withheldCount)).toBe(true);
      expect(
        same(result.disclosedCount, 0) ||
          same(result.disclosedCount, answer.disclosedCount) ||
          (result.disclosedCount === 1 && answer.disclosedCount > 0),
      ).toBe(true);

      if (rungAtLeast(ceiling, 'summary') && rungAtLeast(natural, 'summary')) {
        expect(result.summary).toBe(answer.summary);
      }
    }
  });

  it('never discloses more at a lower ceiling than at a higher one, seed 2', () => {
    const random = prng(2);

    for (let i = 0; i < CASES; i++) {
      const answer = randomAnswer(random);
      const high = pick(random, RUNGS);
      const atHigh = applyDisclosureCeiling(answer, high);

      for (const low of RUNGS.filter((rung) => rungAtLeast(high, rung))) {
        const atLow = applyDisclosureCeiling(answer, low);

        expect(atLow.items.length === 0 || atLow.items === atHigh.items).toBe(true);
        expect(same(atLow.withheldCount, 0) || same(atLow.withheldCount, atHigh.withheldCount)).toBe(true);
        expect(
          same(atLow.disclosedCount, 0) ||
            same(atLow.disclosedCount, atHigh.disclosedCount) ||
            (atLow.disclosedCount === 1 && atHigh.disclosedCount > 0),
        ).toBe(true);
      }
    }
  });

  /**
   * Outside the model. NaN fails `> 0`, so a NaN count reads as "no" at the boolean rung and
   * nothing larger than its input crosses at any rung. The model has no NaN to say this about.
   */
  it('reads a NaN count as nothing at the boolean rung', () => {
    const answer = { ...randomAnswer(prng(3)), form: 'retrieval' as const, disclosedCount: NaN };

    expect(applyDisclosureCeiling(answer, 'boolean')).toMatchObject({ disclosedCount: 0, summary: 'No.' });
    expect(applyDisclosureCeiling(answer, 'count').disclosedCount).toBeNaN();
  });

  // The count rung's sentence uses `${count}`; the model writes the same digits for any
  // integer, and JavaScript agrees with it across the safe range.
  it('writes an integer count the way the model does, seed 4', () => {
    const random = prng(4);

    for (let i = 0; i < CASES; i++) {
      const count = Math.floor((random() * 2 - 1) * Number.MAX_SAFE_INTEGER);
      const answer = { ...randomAnswer(random), form: 'retrieval' as const, disclosedCount: count };
      const expected = count === 1 ? '1 matching item.' : `${BigInt(count).toString()} matching items.`;

      expect(applyDisclosureCeiling(answer, 'count').summary).toBe(expected);
    }
  });
});
