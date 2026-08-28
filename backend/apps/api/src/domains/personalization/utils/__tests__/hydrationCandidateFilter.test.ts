import { shouldSkipHydrationCandidate } from '../hydrationCandidateFilter';

describe('shouldSkipHydrationCandidate', () => {
  it('skips bare times', () => {
    expect(shouldSkipHydrationCandidate('07:00')).toBe(true);
    expect(shouldSkipHydrationCandidate('21:00', 'What time do you usually go to bed?')).toBe(true);
  });

  it('skips autonomy setting answers', () => {
    expect(
      shouldSkipHydrationCandidate(
        'Balanced — high-confidence items auto-promote',
        'How much should your companion do on its own?',
      ),
    ).toBe(true);
  });

  it('skips schedule questions even when answer is not a bare time', () => {
    expect(shouldSkipHydrationCandidate('Early morning', 'What time do you usually wake up?')).toBe(true);
  });

  it('allows free-text interests', () => {
    expect(shouldSkipHydrationCandidate('Hiking on weekends', 'What do you like to do for fun?')).toBe(false);
  });

  describe('long answers reach the extractor', () => {
    // Guards the deliberate ABSENCE of a length/prose test. These are verbatim
    // from ci.promotion_candidates on a real appliance, and an earlier fix
    // skipped them here — correct while the answer text was used as the concept
    // name, wrong now that ConceptExtractionService names the concept from the
    // question and answer. Rejecting them here would hide them from the model.
    const REAL_PROSE_ANSWERS = [
      'I fundamentally rely on logic and detailed analysis because my goal is always to create optimal structure around complex variables.',
      'I am most proud of my capacity to be the proactive architect who establishes structure for the people who depend on me.',
      "Being a parent and spouse defines my life's purpose through my commitment to the people I love.",
    ];

    it.each(REAL_PROSE_ANSWERS)('does not pre-filter %s', (answer) => {
      expect(shouldSkipHydrationCandidate(answer)).toBe(false);
    });

    it('does not pre-filter on length alone', () => {
      expect(shouldSkipHydrationCandidate('a'.repeat(400))).toBe(false);
    });

    it('still allows the short labels this path started with', () => {
      for (const label of ['Hiking', 'Documentaries', 'Ice skating', 'Dr. Who']) {
        expect(shouldSkipHydrationCandidate(label)).toBe(false);
      }
    });
  });
});
