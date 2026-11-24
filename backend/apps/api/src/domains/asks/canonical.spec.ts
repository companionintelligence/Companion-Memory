import {
  canonicalDataClass,
  canonicalQueryType,
  hasInvisibleCharacters,
  normalizeText,
  stripInvisible,
} from './canonical';

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

  it('folds the bidi controls too, which render as nothing between two letters', () => {
    // Each of these displays as `photos` in the owner's Grant Manager, so each
    // must canonicalize to it, or a `photos` block does not fire.
    for (const control of ['\u202a', '\u202e', '\u2066', '\u2069', '\u061c']) {
      expect(canonicalDataClass(`pho${control}tos`)).toBe('photos');
    }
  });

  /**
   * #3184 stripped a hand-picked list. Every one of these also renders as
   * nothing inside `photos`, and each got a blocked asker's `photos` ask into
   * the owner's review queue (RC2 QA, D2).
   */
  it.each([
    ['U+034F combining grapheme joiner', '\u034f'],
    ['U+180E Mongolian vowel separator', '\u180e'],
    ['U+180B Mongolian free variation selector', '\u180b'],
    ['U+FE0F variation selector 16', '\ufe0f'],
    ['U+FE00 variation selector 1', '\ufe00'],
    ['U+E0100 variation selector 17', '\u{e0100}'],
    ['U+E0070 tag p', '\u{e0070}'],
    ['U+E0001 language tag', '\u{e0001}'],
    ['U+E007F cancel tag', '\u{e007f}'],
    ['U+115F Hangul choseong filler', '\u115f'],
    ['U+1160 Hangul jungseong filler', '\u1160'],
    ['U+3164 Hangul filler', '\u3164'],
    ['U+FFA0 halfwidth Hangul filler', '\uffa0'],
    ['U+1D173 musical symbol begin beam', '\u{1d173}'],
    ['U+17B4 Khmer vowel inherent aq', '\u17b4'],
    ['U+2065 unassigned default-ignorable', '\u2065'],
    ['U+1BCA0 shorthand format letter overlap', '\u{1bca0}'],
  ])('folds %s inside a word', (_name, char) => {
    expect(canonicalDataClass(`pho${char}tos`)).toBe('photos');
    expect(canonicalDataClass(`${char}photos${char}`)).toBe('photos');
    expect(canonicalDataClass(`PHO${char}${char}TOS`)).toBe('photos');
  });

  it('never strips a pictograph-only sequence into a word, and keeps two words two words', () => {
    // An emoji's own joiner and selectors stay where the emoji puts them…
    expect(canonicalDataClass('\u{1f469}\u200d\u{1f4bb} photos')).toBe('\u{1f469}\u200d\u{1f4bb} photos');
    expect(canonicalDataClass('\u2764\ufe0f photos')).toBe('\u2764\ufe0f photos');
    // …but a joiner between letters, or between a pictograph and a letter, goes.
    expect(canonicalDataClass('\u{1f4f7}\u200dphotos')).toBe('\u{1f4f7}photos');
    expect(canonicalDataClass('photo\ufe0f\u{1f4f7}')).toBe('photo\u{1f4f7}');
    // A real space survives: stripping must not merge distinct words.
    expect(canonicalDataClass('lake\u034f photos')).toBe('lake photos');
    expect(canonicalDataClass('lake photos')).not.toBe(canonicalDataClass('lakephotos'));
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

describe('hasInvisibleCharacters', () => {
  it('is true exactly when normalizeText would strip a character that renders as nothing', () => {
    for (const value of [
      'lake\u200b photos',
      'soft\u00adhyphen',
      '\ufeffbom',
      'word\u2060joiner',
      'right\u202eoverride',
      'iso\u2066late\u2069',
      'arabic\u061cmark',
      'grapheme\u034fjoiner',
      'pho\u{e0070}tos',
      'hangul\u3164filler',
      'heart-less\ufe0f',
    ]) {
      expect(hasInvisibleCharacters(value)).toBe(true);
      expect(normalizeText(value)?.length).toBeLessThan(value.length);
    }

    // An emoji drawn with its own joiner, selector or flag tags is not hidden text.
    for (const value of [
      'lake photos',
      '  padded\u00a0space  ',
      'Café',
      '',
      'photos of \u2764\ufe0f',
      'the \u{1f468}\u200d\u{1f469}\u200d\u{1f467} trip',
      'thumbs \u{1f44d}\u{1f3fd}\u200d\u{1f4bb}',
      'flag \u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}',
    ]) {
      expect(hasInvisibleCharacters(value)).toBe(false);
    }
  });

  it('answers the same on every call (the shared class is a global regex)', () => {
    expect([1, 2, 3].map(() => hasInvisibleCharacters('pho\u200btos'))).toEqual([true, true, true]);
  });

  it('is false for anything that is not a string', () => {
    for (const value of [42, null, undefined, { toString: () => '\u200b' }]) {
      expect(hasInvisibleCharacters(value)).toBe(false);
    }
  });
});

/**
 * `stripInvisible` is exported for the peers domain (a Local.Pub display name) and is what `normalizeText`
 * runs. The pair-gluing bypass below is the reason it replaces lone surrogates BEFORE it removes anything.
 */
describe('stripInvisible', () => {
  const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
  const unit = (...units: number[]) => String.fromCharCode(...units);
  const REPLACEMENT = cp(0xfffd);

  it('replaces a lone surrogate half, and so cannot glue two halves into a character it never examined', () => {
    // JSON.parse accepts "\ud800". A high half, an invisible character, a low half: removing the middle one
    // used to leave a valid pair, here U+E0041 (a tag A), that no filter had looked at.
    const high = unit(0xdb40);
    const low = unit(0xdc41);

    for (const between of [cp(0x200b), cp(0x202e), cp(0x2060), cp(0xfeff), cp(0x061c)]) {
      const out = stripInvisible(`A${high}${between}${low}B`);

      expect(out).toBe(`A${REPLACEMENT}${REPLACEMENT}B`);
      expect(Array.from(out).every((char) => (char.codePointAt(0) as number) < 0xe0000)).toBe(true);
    }
  });

  it('replaces a lone surrogate on its own, and keeps a proper pair', () => {
    expect(stripInvisible(`x${unit(0xd800)}y`)).toBe(`x${REPLACEMENT}y`);
    expect(stripInvisible(`x${unit(0xdc00)}y`)).toBe(`x${REPLACEMENT}y`);
    expect(stripInvisible(`x${unit(0xd800)}`)).toBe(`x${REPLACEMENT}`);
    expect(stripInvisible(`a${cp(0x1d11e)}b`)).toBe(`a${cp(0x1d11e)}b`);
    expect(stripInvisible(`${cp(0x1f469, 0x200d, 0x1f4bb)}`)).toBe(cp(0x1f469, 0x200d, 0x1f4bb));
  });

  it('is idempotent: stripping what it returned changes nothing, on 3,000 hostile strings', () => {
    // A deterministic mix of letters, invisible characters, surrogate halves, tags, a black flag and emoji parts.
    const alphabet = [
      'a',
      'b',
      ' ',
      cp(0x200b),
      cp(0x200d),
      cp(0xfe0f),
      cp(0x202e),
      cp(0x2060),
      cp(0x061c),
      cp(0xfeff),
      cp(0xe0041),
      cp(0xe007f),
      cp(0x1f3f4),
      cp(0x1f469),
      cp(0x1f4bb),
      cp(0x1d173),
      unit(0xd800),
      unit(0xdb40),
      unit(0xdc00),
      unit(0xdc41),
      cp(0x3164),
      cp(0x34f),
    ];
    let seed = 20261105;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;

      return seed % limit;
    };

    for (let i = 0; i < 3000; i += 1) {
      let value = '';
      for (let j = 0, length = 1 + next(12); j < length; j += 1) {
        value += alphabet[next(alphabet.length)];
      }

      const once = stripInvisible(value);

      expect([value, stripInvisible(once)]).toEqual([value, once]);
    }
  });
});
