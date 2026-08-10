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
});
