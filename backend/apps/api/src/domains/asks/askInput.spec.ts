import { ASK_ARCHETYPES } from './askGrammar';
import {
  MAX_ASK_DATA_CLASS_LENGTH,
  MAX_ASK_PROMPT_LENGTH,
  parseAskDataClass,
  parseAskPrompt,
  parseAskQueryInput,
  parseAskQueryType,
  parseGrantQueryType,
} from './askInput';

/**
 * The boundary where an asker's raw strings become an ask.
 *
 * Each test names the concrete evasion it closes rather than the abstract rule,
 * because both fields here are ATTACKER-CONTROLLED and both are read by the
 * consent gate: `queryType` is half the key every standing grant is matched on,
 * and `prompt` is the sentence the owner reads before consenting.
 */

describe('parseAskQueryType — a closed vocabulary is what makes a block a block', () => {
  it.each([...ASK_ARCHETYPES])('accepts the real archetype %s', (archetype) => {
    expect(parseAskQueryType(archetype)).toBe(archetype);
  });

  /**
   * THE EVASION. Grants are keyed on (grantee, queryType) and matched by
   * canonical string equality. While `queryType` was a free string that key was
   * chosen by the ASKER: an owner who blocked one word was walked past by an
   * asker who typed a different one, the evaluation fell through to the review
   * default, and the blocked person's prompt landed in the owner's inbox again.
   *
   * Canonicalizing the comparison closes the SPELLINGS of one word. Only a
   * closed vocabulary closes the choice of another word.
   */
  it.each(['photos', 'pictures', 'snaps', 'photos-2', 'anything at all', ''])(
    'refuses %p, which no grant could have been written against',
    (word) => {
      expect(() => parseAskQueryType(word)).toThrow(/queryType must be one of/);
    },
  );

  /**
   * Spelling variants of a REAL archetype still normalize in, because
   * `canonicalQueryType` is what compares them and rejecting them here would
   * make this stricter than the gate it feeds — a different bug, not a safer one.
   */
  it.each([
    ['CONTENT', 'content'],
    ['  Content  ', 'content'],
    // U+200B ZERO WIDTH SPACE between the n and the t: renders as `content`.
    ['con​tent', 'content'],
    // Fullwidth, folded by NFKC.
    ['ｃｏｎｔｅｎｔ', 'content'],
    // U+00A0 NO-BREAK SPACE, what a copy-paste out of a document produces.
    ['content ', 'content'],
  ])('normalizes %p to the archetype %p rather than refusing it', (raw, expected) => {
    expect(parseAskQueryType(raw)).toBe(expected);
  });

  it.each([null, undefined, 42, {}, ['content']])('refuses the non-string %p', (raw) => {
    expect(() => parseAskQueryType(raw)).toThrow(/queryType must be one of/);
  });

  /**
   * The WRITING end of the same vocabulary. An owner who writes `block` on a
   * word no ask can carry has written nothing, while the Grant Manager shows it
   * back to them as live protection — so leaving this end open would make
   * "I blocked this" and "this is blocked" two different statements.
   */
  it('holds grant authoring to the same vocabulary as asking', () => {
    expect(parseGrantQueryType('relationship')).toBe('relationship');
    expect(() => parseGrantQueryType('photos')).toThrow(/queryType must be one of/);
  });
});

describe('parseAskPrompt — bounded, normalized, and never silently shortened', () => {
  it('keeps the asker’s own words, case and all', () => {
    // Case is NOT folded: the owner reads this sentence before consenting, and
    // rewriting it would put words in the asker's mouth in the one place a human
    // looks.
    expect(parseAskPrompt('Do You Know Alice?')).toBe('Do You Know Alice?');
  });

  it('strips invisibles and collapses every flavour of space, using the shared normalizer', () => {
    // The class beside this field could not carry a zero-width space; this one
    // could. Two strings that render identically and compare unequal is a
    // block-evasion primitive wherever it survives — and here it would let an
    // asker write one question for the human reading the inbox and another for
    // anything that later reads the stored jsonb.
    expect(parseAskPrompt('do you​ have  photos?')).toBe('do you have photos?');
  });

  it('refuses a prompt that is nothing but whitespace and invisibles', () => {
    // Renders as an empty question in the owner's review inbox, which is not
    // something anybody can consent to.
    expect(() => parseAskPrompt(' ​  ')).toThrow(/prompt must not be empty/);
    expect(() => parseAskPrompt('')).toThrow(/prompt must not be empty/);
  });

  it('accepts exactly the cap and REJECTS one character past it', () => {
    const atCap = 'a'.repeat(MAX_ASK_PROMPT_LENGTH);
    expect(parseAskPrompt(atCap)).toHaveLength(MAX_ASK_PROMPT_LENGTH);

    // Rejected, never truncated. A silently shortened prompt is a DIFFERENT
    // question from the one the asker wrote, shown to the owner as though it
    // were theirs, and consented to on that basis.
    expect(() => parseAskPrompt('a'.repeat(MAX_ASK_PROMPT_LENGTH + 1))).toThrow(/prompt must be at most/);
  });

  it('refuses a megabyte before it normalizes it', () => {
    // The raw bound exists so three full normalization passes are never run on
    // an unbounded string just to reach the length check that was going to
    // refuse it.
    expect(() => parseAskPrompt('a'.repeat(1_000_000))).toThrow(/prompt must be at most/);
  });

  it('judges length AFTER normalizing, so padding with invisibles buys nothing', () => {
    // 500 real characters plus 200 zero-width ones is a 500-character prompt.
    const padded = `${'a'.repeat(MAX_ASK_PROMPT_LENGTH)}${'​'.repeat(200)}`;
    expect(parseAskPrompt(padded)).toHaveLength(MAX_ASK_PROMPT_LENGTH);
  });

  it.each([null, undefined, 42, {}])('refuses the non-string %p', (raw) => {
    expect(() => parseAskPrompt(raw)).toThrow(/prompt must be a string/);
  });
});

describe('parseAskDataClass — optional, bounded, and normalized the same way', () => {
  it('passes an ordinary class through in display form', () => {
    expect(parseAskDataClass('Photos')).toBe('Photos');
  });

  it('reads an absent or empty class as the ABSENCE of one', () => {
    // Both readings resolve toward denial downstream: a block covers a
    // class-less ask, and an `auto` grant does not cover one.
    expect(parseAskDataClass(undefined)).toBeUndefined();
    expect(parseAskDataClass(null)).toBeUndefined();
    expect(parseAskDataClass('   ')).toBeUndefined();
  });

  it('caps the class, so a megabyte cannot be replayed into every audit row', () => {
    expect(() => parseAskDataClass('c'.repeat(MAX_ASK_DATA_CLASS_LENGTH + 1))).toThrow(
      /dataClass must be at most/,
    );
    expect(() => parseAskDataClass('c'.repeat(1_000_000))).toThrow(/dataClass must be at most/);
  });
});

describe('parseAskQueryInput — the only shape allowed downstream', () => {
  it('builds the query field by field, dropping anything else the caller sent', () => {
    const parsed = parseAskQueryInput({
      queryType: 'content',
      dataClass: 'photos',
      prompt: 'photos of the lake trip?',
      // Unknown keys must not reach `ci.asks.query` (jsonb) and from there the
      // audit replay. Spreading the attacker-shaped input is how they would.
      __proto__: { polluted: true },
      extra: 'smuggled',
    } as never);

    expect(parsed).toEqual({
      queryType: 'content',
      dataClass: 'photos',
      prompt: 'photos of the lake trip?',
    });
    // The SET of keys, not their order: this pins "nothing else got through",
    // and jsonb key order carries no meaning downstream.
    expect(Object.keys(parsed).sort()).toEqual(['dataClass', 'prompt', 'queryType']);
  });

  describe('actor — who is making the ask', () => {
    it('carries a declared actor through', () => {
      const parsed = parseAskQueryInput({
        queryType: 'content',
        prompt: 'the deck',
        actor: { kind: 'first-party-agent', label: 'Ana’s Companion' },
      });

      expect(parsed.actor).toEqual({ kind: 'first-party-agent', label: 'Ana’s Companion' });
    });

    it('omits the key entirely when none is declared', () => {
      expect(parseAskQueryInput({ queryType: 'content', prompt: 'x' })).not.toHaveProperty('actor');
    });

    /**
     * An off-contract actor parses to NO actor rather than to `person`.
     * Defaulting would let an agent satisfy a `delegation: 'none'` grant by
     * sending something malformed, which is strictly easier than sending
     * something honest.
     */
    it.each([
      ['an unknown kind', { kind: 'robot' }],
      ['no kind at all', { label: 'something' }],
      ['a non-object', 'person'],
      ['null', null],
      ['a numeric kind', { kind: 7 }],
    ])('drops %s rather than defaulting to a person', (_name, actor) => {
      expect(parseAskQueryInput({ queryType: 'content', prompt: 'x', actor } as never)).not.toHaveProperty(
        'actor',
      );
    });

    it('accepts a kind in any casing, because the vocabulary is the point', () => {
      expect(
        parseAskQueryInput({ queryType: 'content', prompt: 'x', actor: { kind: ' PERSON ' } }).actor,
      ).toEqual({ kind: 'person' });
    });

    it('truncates an over-long label rather than refusing the ask', () => {
      // Unlike a prompt — which is the question being consented to and must
      // never be silently altered — a label is decoration beside it.
      const parsed = parseAskQueryInput({
        queryType: 'content',
        prompt: 'x',
        actor: { kind: 'third-party-agent', label: 'z'.repeat(500) },
      });

      expect(parsed.actor?.label).toHaveLength(80);
    });

    it('drops a blank label instead of storing whitespace', () => {
      expect(
        parseAskQueryInput({ queryType: 'content', prompt: 'x', actor: { kind: 'person', label: '   ' } })
          .actor,
      ).toEqual({ kind: 'person' });
    });
  });

  it('records that hidden characters were stripped from the prompt, so the owner can be told', () => {
    // The stored prompt has no zero-width characters left in it, so the review
    // card cannot find them itself; this flag is the only trace.
    const parsed = parseAskQueryInput({ queryType: 'relationship', prompt: 'Do you have the lake​ photos?' });

    expect(parsed).toEqual({
      queryType: 'relationship',
      prompt: 'Do you have the lake photos?',
      promptHiddenCharactersRemoved: true,
    });
  });

  it('leaves the flag off when nothing was stripped (whitespace tidying does not count)', () => {
    expect(
      parseAskQueryInput({ queryType: 'relationship', prompt: '  Do you have the lake photos?  ' }),
    ).not.toHaveProperty('promptHiddenCharactersRemoved');
  });

  it('omits dataClass entirely when the ask names none', () => {
    expect(parseAskQueryInput({ queryType: 'relationship', prompt: 'do you know Alice?' })).toEqual({
      queryType: 'relationship',
      prompt: 'do you know Alice?',
    });
  });

  it('refuses the whole query when either field is off-contract', () => {
    expect(() => parseAskQueryInput({ queryType: 'photos', prompt: 'hi' })).toThrow(
      /queryType must be one of/,
    );
    expect(() => parseAskQueryInput({ queryType: 'content', prompt: '' })).toThrow(
      /prompt must not be empty/,
    );
  });
});
