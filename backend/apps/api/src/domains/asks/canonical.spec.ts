import { canonicalDataClass, canonicalQueryType } from './canonical';

/**
 * The shared normalizer for the two asker-supplied strings the consent gate
 * matches on. Its spelling-folding behaviour is covered end-to-end by
 * grantMatch.spec (a block must not be evadable by casing or padding); what is
 * pinned here is the contract the callers rely on — that it is TOTAL, and that
 * everything it cannot read collapses to `null`.
 */
describe('canonicalDataClass', () => {
  it('folds the spellings that render identically', () => {
    expect(canonicalDataClass('Photos')).toBe('photos');
    expect(canonicalDataClass('  photos  ')).toBe('photos');
    expect(canonicalDataClass('photos ')).toBe('photos');
    expect(canonicalDataClass('pho​tos')).toBe('photos');
    expect(canonicalDataClass('ｐｈｏｔｏｓ')).toBe('photos');
  });

  it('answers null — never an empty string — for a value that names no class', () => {
    // The callers read "no class named" off a nullish value; `''` is not a
    // class the owner wrote down.
    expect(canonicalDataClass('')).toBeNull();
    expect(canonicalDataClass('   ')).toBeNull();
    expect(canonicalDataClass('​')).toBeNull();
    expect(canonicalDataClass(null)).toBeNull();
    expect(canonicalDataClass(undefined)).toBeNull();
  });

  /**
   * ═══ A NON-STRING USED TO THROW, MID-CONSENT-EVALUATION ═══
   *
   * `dataClass` is typed `string`, but it reaches this function out of jsonb
   * (`asks.query`, `ask_grants.scope.dataClasses`) and from service callers that
   * never pass through the GraphQL or zod schemas — so the type is a claim, not
   * a guarantee. Calling `.normalize()` on a number threw a TypeError from
   * inside `evaluateGrant`, which surfaces as a 500; and because
   * `AskService.submit` inserts the ask row BEFORE it evaluates, the throw also
   * stranded that row in `delivered` with no decision ever recorded.
   */
  describe('SECURITY: total over hostile, mis-typed input', () => {
    it.each([42, 0, true, false, {}, [], ['photos'], Symbol('photos'), () => 'photos', 12n])(
      'answers null instead of throwing for %p',
      (value) => {
        expect(() => canonicalDataClass(value)).not.toThrow();
        expect(canonicalDataClass(value)).toBeNull();
      },
    );

    it('does not COERCE a non-string into a class name', () => {
      // `String(42)` is not a class the owner wrote down, and an object with a
      // hand-written `toString` would get to choose one. Reading as "no class
      // named" is the deny-biased answer on both paths: a block covers an ask
      // that names no class, and an `auto` grant does not.
      expect(canonicalDataClass(42)).not.toBe('42');
      expect(canonicalDataClass({ toString: () => 'photos' })).toBeNull();
    });
  });
});

describe('canonicalQueryType', () => {
  it('is the SAME normalizer, so the two halves of a grant key cannot drift', () => {
    for (const value of ['Photos', '  photos ', 'pho​tos', 42, null]) {
      expect(canonicalQueryType(value)).toEqual(canonicalDataClass(value));
    }
  });
});
