import { ALWAYS_REVIEW_BELOW_CONFIDENCE, PersonalizationService } from '../PersonalizationService';

describe('PersonalizationService.decide for inferred_fact', () => {
  it('cautious always asks before saving inferred answers', () => {
    const profile = PersonalizationService.profileForTrustMode('cautious');

    expect(PersonalizationService.decide(profile, { kind: 'inferred_fact', confidence: 0.95 })).toBe(
      'review',
    );
    expect(PersonalizationService.decide(profile, { kind: 'inferred_fact', confidence: 0.5 })).toBe('review');
  });

  it('balanced auto-accepts high-confidence inferences and asks for the rest', () => {
    const profile = PersonalizationService.profileForTrustMode('balanced');

    expect(PersonalizationService.decide(profile, { kind: 'inferred_fact', confidence: 0.9 })).toBe('auto');
    expect(PersonalizationService.decide(profile, { kind: 'inferred_fact', confidence: 0.76 })).toBe(
      'review',
    );
    expect(PersonalizationService.decide(profile, { kind: 'inferred_fact', confidence: 0.5 })).toBe('review');
  });

  it('hands_off auto-accepts solid inferred answers and asks for low confidence', () => {
    const profile = PersonalizationService.profileForTrustMode('hands_off');

    expect(PersonalizationService.decide(profile, { kind: 'inferred_fact', confidence: 0.95 })).toBe('auto');
    expect(PersonalizationService.decide(profile, { kind: 'inferred_fact', confidence: 0.72 })).toBe('auto');
    expect(PersonalizationService.decide(profile, { kind: 'inferred_fact', confidence: 0.55 })).toBe(
      'review',
    );
  });
});

describe('PersonalizationService.decide for graph connections', () => {
  it('always asks in cautious and balanced even at high confidence', () => {
    const cautious = PersonalizationService.profileForTrustMode('cautious');
    const balanced = PersonalizationService.profileForTrustMode('balanced');

    for (const profile of [cautious, balanced]) {
      expect(
        PersonalizationService.decide(profile, { kind: 'graph_edge', confidence: 0.95, hasUserInput: true }),
      ).toBe('review');
      expect(
        PersonalizationService.decide(profile, {
          kind: 'graph_entity',
          confidence: 0.95,
          hasUserInput: true,
        }),
      ).toBe('review');
    }
  });

  it('only hands_off auto-applies moderately confident graph connections', () => {
    const handsOff = PersonalizationService.profileForTrustMode('hands_off');

    expect(
      PersonalizationService.decide(handsOff, { kind: 'graph_edge', confidence: 0.8, hasUserInput: true }),
    ).toBe('auto');
    expect(
      PersonalizationService.decide(handsOff, { kind: 'graph_edge', confidence: 0.72, hasUserInput: true }),
    ).toBe('auto');
    expect(
      PersonalizationService.decide(handsOff, { kind: 'graph_edge', confidence: 0.65, hasUserInput: true }),
    ).toBe('review');
  });

  it('always asks below the low-confidence floor in every trust mode', () => {
    for (const mode of ['cautious', 'balanced', 'hands_off'] as const) {
      const profile = PersonalizationService.profileForTrustMode(mode);

      expect(
        PersonalizationService.decide(profile, {
          kind: 'graph_edge',
          confidence: ALWAYS_REVIEW_BELOW_CONFIDENCE - 0.05,
          hasUserInput: true,
        }),
      ).toBe('review');
    }
  });
});

describe('PersonalizationService.thresholdForKind', () => {
  it('requires certainty for graph connections unless hands_off', () => {
    const balanced = PersonalizationService.profileForTrustMode('balanced');
    const handsOff = PersonalizationService.profileForTrustMode('hands_off');

    expect(PersonalizationService.thresholdForKind(balanced, 'graph_edge')).toBe(1);
    expect(PersonalizationService.thresholdForKind(handsOff, 'graph_edge')).toBe(0.7);
  });
});
