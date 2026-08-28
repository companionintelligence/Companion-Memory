import { buildPromptQuery } from './promptQuery';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO RULES THAT STOP THIS BOX ANSWERING "YES" ABOUT PEOPLE IT NEVER MET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every test here fails if its rule is removed — that is the point of the file.
 * Measured against the owner's real 19,241-entity archive before the rules
 * existed: "Have you seen <invented name>?" matched 297 entities (all on the
 * word 'seen'), and "Do you have photos of <invented name>?" matched 529 (all
 * on 'photo'). Both answered "Yes."
 */
describe('buildPromptQuery', () => {
  describe('ask scaffolding is not evidence', () => {
    it.each(['know', 'seen', 'met', 'told', 'heard', 'remember', 'ever'])(
      'drops %s, which Postgres’ english dictionary keeps',
      (word) => {
        const groups = buildPromptQuery(`have you ${word} anything`);

        expect(groups).toEqual([]);
      },
    );

    it('keeps a content word that merely looks like scaffolding', () => {
      // 'meeting' and 'live' read like question words and are NOT: they name
      // things the owner actually remembers. Dropping them would make a
      // legitimate ask unanswerable, which is a different kind of wrong answer.
      expect(buildPromptQuery('the meeting')).toEqual([{ kind: 'term', text: 'meeting' }]);
      expect(buildPromptQuery('live album')).toEqual([
        { kind: 'term', text: 'live' },
        { kind: 'term', text: 'album' },
      ]);
    });

    it('leaves nothing at all for a question with no subject', () => {
      // "do you know?" matched 10 entities on the demo corpus before this rule.
      expect(buildPromptQuery('do you know?', { subjectIsName: true })).toEqual([]);
      expect(buildPromptQuery('Have you seen anything?')).toEqual([]);
    });
  });

  describe('a named thing is a constraint, not an alternative', () => {
    it('binds a run of capitalised words as one required phrase', () => {
      // Groups come back in prompt order; the SQL side decides which are
      // required and which are alternatives, not the order they appear in.
      expect(buildPromptQuery('Do you have photos of Zerbcorpolis Fnargle?')).toEqual([
        { kind: 'term', text: 'photos' },
        { kind: 'phrase', text: 'Zerbcorpolis Fnargle' },
      ]);
    });

    it('leaves a lone capitalised word an alternative', () => {
      // Requiring every sentence-initial capital would narrow every prompt that
      // starts with one. Only ADJACENCY between two names is evidence.
      expect(buildPromptQuery('Photos of the lake')).toEqual([
        { kind: 'term', text: 'Photos' },
        { kind: 'term', text: 'lake' },
      ]);
    });

    it('binds the whole residual for an ask whose subject IS a name', () => {
      // The peer wire puts `relationshipAskSchema.subject` straight into the
      // prompt, and it promises nothing about capitalisation — so a name ask
      // must not depend on it. Lower case has to bind exactly as tightly.
      expect(buildPromptQuery('do you know david miller', { subjectIsName: true })).toEqual([
        { kind: 'phrase', text: 'david miller' },
      ]);
      expect(buildPromptQuery('Do you know David Miller?', { subjectIsName: true })).toEqual([
        { kind: 'phrase', text: 'David Miller' },
      ]);
    });

    it('requires EVERY name an ask mentions, never just one of them', () => {
      // "Yes" because one of the two people is known is the same fabrication in
      // a different shape.
      expect(buildPromptQuery('Do you know Alice Smith or Bob Jones?', { subjectIsName: true })).toEqual([
        { kind: 'phrase', text: 'Alice Smith' },
        { kind: 'phrase', text: 'Bob Jones' },
      ]);
    });
  });

  describe('run boundaries', () => {
    it('does not splice two names across punctuation', () => {
      // "Alice, Bob" is two people. Bound as one phrase it names nobody, and a
      // phrase that can never match silently turns every such ask into "no".
      expect(buildPromptQuery('Alice, Bob')).toEqual([
        { kind: 'term', text: 'Alice' },
        { kind: 'term', text: 'Bob' },
      ]);
    });

    it('does not splice two names across a removed frame word', () => {
      // ORDERING TRAP: frame removal has to CUT the run, not filter it after the
      // fact. Filtering afterwards turns "Amanda Tell Brian" into the phrase
      // 'amanda' <-> 'brian', which names nobody.
      expect(buildPromptQuery('Did Amanda Tell Brian about it?')).toEqual([
        { kind: 'term', text: 'Amanda' },
        { kind: 'term', text: 'Brian' },
      ]);
    });

    it('keeps a multi-word name together across plain spaces only', () => {
      expect(buildPromptQuery('Lake  Tahoe trip')).toEqual([
        { kind: 'phrase', text: 'Lake Tahoe' },
        { kind: 'term', text: 'trip' },
      ]);
    });

    it('treats a newline as a boundary, not a space', () => {
      expect(buildPromptQuery('Alice\nBob')).toEqual([
        { kind: 'term', text: 'Alice' },
        { kind: 'term', text: 'Bob' },
      ]);
    });
  });

  describe('nothing in, nothing out', () => {
    it.each([
      ['empty', ''],
      ['whitespace', '   '],
      ['punctuation', '???'],
      ['emoji', '\u{1F914}'],
    ])('%s yields no groups at all', (_label, prompt) => {
      // The caller MUST read this as "match nothing". A question with no
      // subject has no true answer to disclose.
      expect(buildPromptQuery(prompt)).toEqual([]);
      expect(buildPromptQuery(prompt, { subjectIsName: true })).toEqual([]);
    });
  });
});
