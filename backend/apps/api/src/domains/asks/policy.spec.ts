import {
  applyDisclosureCeiling,
  disclosureCeiling,
  minRung,
  narrowerForm,
  rungAtLeast,
  rungForForm,
} from './policy';
import type { DisclosedAnswer } from './types';

function answer(overrides: Partial<DisclosedAnswer> = {}): DisclosedAnswer {
  return {
    form: 'retrieval',
    items: [
      { id: 'a', type: 'file' },
      { id: 'b', type: 'file' },
    ],
    disclosedCount: 2,
    withheldCount: 1,
    summary: 'They shared 2 items.',
    consentBasis: 'grant-1',
    ...overrides,
  };
}

describe('rung ordering', () => {
  it('orders the ladder coarsest-first', () => {
    expect(rungAtLeast('full', 'boolean')).toBe(true);
    expect(rungAtLeast('boolean', 'full')).toBe(false);
    expect(rungAtLeast('summary', 'summary')).toBe(true);
    expect(minRung('full', 'count')).toBe('count');
    expect(minRung('none', 'boolean')).toBe('none');
  });
});

describe('disclosureCeiling', () => {
  it('gives household and family the widest ceiling', () => {
    expect(disclosureCeiling('household', 'photos')).toBe('full');
    expect(disclosureCeiling('family', 'photos')).toBe('full');
  });

  it('tightens as trust decreases', () => {
    expect(disclosureCeiling('trusted', 'photos')).toBe('redacted');
    expect(disclosureCeiling('peer', 'documents')).toBe('summary');
    expect(disclosureCeiling('stranger', 'photos')).toBe('boolean');
  });

  /**
   * ═══ NAMING A CLASS USED TO BUY MORE DISCLOSURE, NOT LESS ═══
   *
   * The `peer` row reads `{ '*': 'summary', photos: 'redacted' }`, and
   * `redacted` sits ABOVE `summary` on the ladder — so a peer who wrote
   * `dataClass: 'photos'` got ITEM REFERENCES back where the identical ask
   * without the label got a sentence. The label is asker-supplied and, because
   * `AskExecutorService` resolves `photos` to the whole `file` entity type,
   * those references were never confined to photographs either: every document,
   * receipt and scan the keyword matched came back with them.
   */
  it('SECURITY: a per-class entry may only TIGHTEN the tier fallback, never raise it', () => {
    expect(disclosureCeiling('peer', 'photos')).toBe('summary');
    // The same table row read the other way round: a class entry BELOW the
    // fallback still applies in full.
    expect(disclosureCeiling('peer', 'location')).toBe('none'); // sensitive, capped harder still
    expect(disclosureCeiling('family', 'location')).toBe('redacted');
  });

  /**
   * ═══ OMITTING THE LABEL USED TO BE THE MOST GENEROUS THING AN ASKER COULD DO ═══
   *
   * `dataClass` is optional, so an ask can decline to name one — and an unnamed
   * class is not a narrower ask, it is the broadest one: the executor turns it
   * into an unfiltered search across every indexed entity type. It nonetheless
   * received the `'*'` fallback, the ceiling written for "some ordinary class",
   * skipping every per-class tightening the tier declared.
   *
   * It now gets the tier's FLOOR — the narrowest rung that tier grants anywhere.
   * Deliberately the floor rather than a flat `none`: this function sees only a
   * tier and a class, so it cannot tell a `relationship` ask (which has no class
   * to name) from a `content` ask that dropped its label, and capping every
   * class-less ask at nothing would retire the archetype rather than secure it.
   * The AUTOMATIC path is closed at the grant layer instead — see
   * `autoGrantNamesQueryClass`, which no longer lets any grant auto-answer an
   * ask that names no class.
   */
  it('SECURITY: an ask that names NO class gets the tier floor, not the `*` fallback', () => {
    for (const absent of [undefined, null, '', '   ']) {
      expect(disclosureCeiling('trusted', absent)).toBe('summary'); // was 'redacted'
      expect(disclosureCeiling('peer', absent)).toBe('count'); // was 'summary'
      expect(disclosureCeiling('stranger', absent)).toBe('none'); // was 'boolean'
      expect(disclosureCeiling('family', absent)).toBe('redacted'); // was 'full'
    }

    // Household is a member of the owner's own box and declares no per-class
    // tightening at all, so its floor IS its fallback.
    expect(disclosureCeiling('household', undefined)).toBe('full');
  });

  it('never throws on a mis-typed class, and reads it as no class named', () => {
    // Same jsonb-shaped hazard `canonicalDataClass` is hardened against: a 500
    // here would take out the answer path, not just the ceiling.
    expect(disclosureCeiling('peer', 42 as never)).toBe('count');
    expect(disclosureCeiling('peer', {} as never)).toBe('count');
  });

  it('caps sensitive classes at none below family, forcing owner review', () => {
    for (const cls of ['health', 'medical', 'financial', 'secrets', 'location']) {
      expect(disclosureCeiling('stranger', cls)).toBe('none');
      expect(disclosureCeiling('peer', cls)).toBe('none');
      expect(disclosureCeiling('trusted', cls)).toBe('none');
    }

    // household/family may still receive them (subject to a grant)
    expect(disclosureCeiling('family', 'health')).not.toBe('none');
  });

  it('canonicalizes the class so casing cannot evade the sensitive cap', () => {
    expect(disclosureCeiling('stranger', '  HEALTH  ')).toBe('none');
  });

  it('falls back to the strictest posture for an unknown tier', () => {
    expect(disclosureCeiling('nonsense' as never, 'photos')).toBe('boolean');
  });
});

describe('applyDisclosureCeiling', () => {
  it('leaves an answer alone when the ceiling is at or above its natural rung', () => {
    expect(applyDisclosureCeiling(answer(), 'full')).toEqual(answer());
  });

  /**
   * `redacted` sits BELOW `full`, and it used to return the same object — the
   * clamp read `if (effective === 'full' || effective === 'redacted') return
   * answer`, so a grant capped at "share only what I kept" disclosed exactly as
   * much as one with no cap at all. A rung that clamps nothing is not a rung;
   * it is a label the owner can pick believing it does something.
   */
  describe('redacted is strictly below full', () => {
    it('keeps the kept references but stops reporting how many were withheld', () => {
      const clamped = applyDisclosureCeiling(answer(), 'redacted');

      // The owner's redaction was already applied upstream, so what they kept
      // still crosses…
      expect(clamped.items).toEqual(answer().items);
      // …but "and there were N more" is its own disclosure, and `redacted`
      // means the asker learns nothing about the rest.
      expect(clamped.withheldCount).toBe(0);
      expect(answer().withheldCount).toBeGreaterThan(0);
    });

    it('discloses strictly less than full for the same answer', () => {
      const atFull = applyDisclosureCeiling(answer(), 'full');
      const atRedacted = applyDisclosureCeiling(answer(), 'redacted');

      expect(atRedacted).not.toEqual(atFull);
      expect(atRedacted.withheldCount).toBeLessThan(atFull.withheldCount);
    });
  });

  it('drops item references at summary and below', () => {
    for (const rung of ['summary', 'count', 'boolean', 'none'] as const) {
      expect(applyDisclosureCeiling(answer(), rung).items).toEqual([]);
    }
  });

  it('zeroes withheldCount once items are hidden (it is itself a signal)', () => {
    expect(applyDisclosureCeiling(answer(), 'summary').withheldCount).toBe(0);
    expect(applyDisclosureCeiling(answer(), 'count').withheldCount).toBe(0);
  });

  it('collapses to yes/no at boolean without revealing how many', () => {
    const clamped = applyDisclosureCeiling(answer({ disclosedCount: 7 }), 'boolean');
    expect(clamped.disclosedCount).toBe(1);
    expect(clamped.summary).toBe('Yes.');
    expect(applyDisclosureCeiling(answer({ disclosedCount: 0 }), 'boolean').summary).toBe('No.');
  });

  it('discloses nothing at none', () => {
    const clamped = applyDisclosureCeiling(answer({ disclosedCount: 9 }), 'none');
    expect(clamped).toMatchObject({ items: [], disclosedCount: 0, withheldCount: 0 });
    expect(clamped.summary).toBe('Nothing was shared.');
  });

  it('never widens: a boolean-form answer stays boolean even under a full ceiling', () => {
    const boolAnswer = answer({ form: 'boolean', items: [] });
    expect(applyDisclosureCeiling(boolAnswer, 'full').items).toEqual([]);
    expect(rungForForm('boolean')).toBe('boolean');
  });
});

/**
 * The owner's choice of form is a LIMIT, not a selector. If it could raise the
 * rung, the argument that exists to let the responder share less would become a
 * way for a caller to share more than the ask's own archetype implies.
 */
describe('narrowerForm', () => {
  it('takes the owner’s form when it discloses less', () => {
    expect(narrowerForm('boolean', 'retrieval')).toBe('boolean');
    expect(narrowerForm('existence', 'retrieval')).toBe('existence');
    expect(narrowerForm('attribute', 'retrieval')).toBe('attribute');
  });

  it('keeps the inferred form when the owner’s would disclose MORE', () => {
    expect(narrowerForm('retrieval', 'boolean')).toBe('boolean');
    expect(narrowerForm('attribute', 'existence')).toBe('existence');
    expect(narrowerForm('existence', 'boolean')).toBe('boolean');
  });

  it('gives a tie to the owner, who is the one expressing intent', () => {
    // Both sit on the `boolean` rung; the wording the asker sees differs.
    expect(narrowerForm('identity', 'boolean')).toBe('identity');
    expect(narrowerForm('boolean', 'identity')).toBe('boolean');
  });
});

/**
 * ═══ D6: THE HOUSEHOLD EXEMPTION, PINNED ═══
 *
 * From docs/asks-threat-model.md §10: *"The `household` half of the
 * sensitive-class exemption is pinned by no test"* — mutation-verified there by
 * deleting `tier !== 'household'` from `disclosureCeiling`, after which **544
 * tests passed and 0 failed**.
 *
 * These pin it. They are deliberately written as a STATEMENT OF THE CURRENT
 * DECISION rather than as an assertion that it is correct: whether a housemate
 * should keep the widest ceiling and the sensitive-class exemption is threat
 * model §12 decision #1, and it is written up in docs/asks-household-default.md.
 *
 * Whichever way that goes, these tests are what makes the change DELIBERATE —
 * flipping the default now turns them red, which is the point. Do not delete
 * them to make a change pass; update them, and update the doc with it.
 */
describe('the household exemption (D6)', () => {
  const SENSITIVE = ['health', 'medical', 'financial', 'finance', 'secrets', 'credentials', 'location'];

  it('exempts household from the sensitive-class floor — every class, at full', () => {
    for (const dataClass of SENSITIVE) {
      expect(disclosureCeiling('household', dataClass)).toBe('full');
    }
  });

  it('exempts family too, which is the other half of the same clause', () => {
    // `family` has its own `location: 'redacted'` entry, so it is not uniformly
    // `full` — but it is exempt from the `none` floor, which is the clause.
    for (const dataClass of SENSITIVE) {
      expect(disclosureCeiling('family', dataClass)).not.toBe('none');
    }
  });

  it('applies the floor to every OTHER tier, which is what makes the exemption an exemption', () => {
    for (const tier of ['trusted', 'peer', 'stranger'] as const) {
      for (const dataClass of SENSITIVE) {
        expect(disclosureCeiling(tier, dataClass)).toBe('none');
      }
    }
  });

  /**
   * The reason the exemption mattered so much: a local asker could not be
   * anything BUT household. Now they can, and a demoted housemate picks up the
   * floor like anyone else — which is the whole point of `ci.household_tiers`.
   */
  it('a demoted housemate gets the floor, because the tier is what decides it', () => {
    expect(disclosureCeiling('household', 'health')).toBe('full');
    expect(disclosureCeiling('trusted', 'health')).toBe('none');
  });
});
