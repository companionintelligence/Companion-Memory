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
    // 0.76 used to review: the promote threshold was 0.85, which collided with
    // CONFIDENCE_IMPLIED_CEILING so no 'implied' answer could ever be written.
    // Both the threshold and the review floor are 0.55 now — an answer citing
    // the owner's own words gets surfaced with its provenance rather than
    // discarded into a 'review' verdict that nothing in the repo consumes.
    expect(PersonalizationService.decide(profile, { kind: 'inferred_fact', confidence: 0.76 })).toBe('auto');
    expect(PersonalizationService.decide(profile, { kind: 'inferred_fact', confidence: 0.55 })).toBe('auto');
    // Still reviewed below the floor — 0.55 is a real boundary, not "write everything".
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

describe('PersonalizationService.decide for planning task kinds', () => {
  it('cautious always reviews task_create / mutate / complete / event_revise', () => {
    const profile = PersonalizationService.profileForTrustMode('cautious');

    for (const kind of [
      'task_create',
      'task_mutate',
      'task_complete',
      'event_revise',
      'schedule_accept',
    ] as const) {
      expect(PersonalizationService.decide(profile, { kind, confidence: 0.99 })).toBe('review');
    }
  });

  it('balanced reviews schedule_accept unless autoSchedule is on at high confidence', () => {
    const profile = PersonalizationService.profileForTrustMode('balanced');

    expect(PersonalizationService.decide(profile, { kind: 'schedule_accept', confidence: 0.95 })).toBe(
      'review',
    );
  });

  it('hands_off auto-places schedule_accept at the promote threshold', () => {
    const profile = PersonalizationService.profileForTrustMode('hands_off');

    expect(PersonalizationService.decide(profile, { kind: 'schedule_accept', confidence: 0.72 })).toBe(
      'auto',
    );
  });

  it('balanced auto-accepts at the promote threshold and reviews below', () => {
    const profile = PersonalizationService.profileForTrustMode('balanced');

    expect(PersonalizationService.decide(profile, { kind: 'task_create', confidence: 0.9 })).toBe('auto');
    // task_complete keeps its own 0.85 bar — see the dedicated test below for
    // why it does not share `autoPromoteThresholdBalanced`.
    expect(PersonalizationService.decide(profile, { kind: 'task_complete', confidence: 0.85 })).toBe('auto');
    // task_create/task_mutate/event_revise DO share `autoPromoteThresholdBalanced`
    // with inferred_fact, so lowering it for answers moved these too. 0.8 now
    // promotes; the boundary this test guards is the 0.55 floor beneath it.
    expect(PersonalizationService.decide(profile, { kind: 'task_mutate', confidence: 0.8 })).toBe('auto');
    expect(PersonalizationService.decide(profile, { kind: 'task_mutate', confidence: 0.54 })).toBe('review');
  });

  it('hands_off auto-accepts from 0.7 upward', () => {
    const profile = PersonalizationService.profileForTrustMode('hands_off');

    expect(PersonalizationService.decide(profile, { kind: 'event_revise', confidence: 0.72 })).toBe('auto');
    expect(PersonalizationService.decide(profile, { kind: 'task_create', confidence: 0.65 })).toBe('review');
  });

  it('balanced keeps task_complete at the original 0.85 bar, decoupled from autoPromoteThresholdBalanced', () => {
    const profile = PersonalizationService.profileForTrustMode('balanced');

    // 0.8 is VerifyDoneService's ATTRIBUTED_DONE_CONFIDENCE — the strongest
    // signal it ever reports for a completed task. It must still review in
    // balanced: sharing the 0.55 autoPromoteThreshold here would silently
    // complete tasks (and their calendar blocks) in the default trust mode.
    expect(PersonalizationService.decide(profile, { kind: 'task_complete', confidence: 0.8 })).toBe('review');
    expect(PersonalizationService.decide(profile, { kind: 'task_complete', confidence: 0.84 })).toBe(
      'review',
    );
    expect(PersonalizationService.decide(profile, { kind: 'task_complete', confidence: 0.85 })).toBe('auto');

    // Other planning kinds are unaffected and still share the 0.55 bar.
    expect(PersonalizationService.decide(profile, { kind: 'task_mutate', confidence: 0.8 })).toBe('auto');
  });

  it('thresholdForKind reports the same task_complete bar decide() uses', () => {
    const balanced = PersonalizationService.profileForTrustMode('balanced');
    const handsOff = PersonalizationService.profileForTrustMode('hands_off');

    expect(PersonalizationService.thresholdForKind(balanced, 'task_complete')).toBe(0.85);
    expect(PersonalizationService.thresholdForKind(handsOff, 'task_complete')).toBe(0.7);
  });
});

describe('PersonalizationService.getProfile cache', () => {
  function serviceReading(trustModes: string[]) {
    const findById = jest.fn(async () => ({ properties: { planner: { trust_mode: trustModes.shift() } } }));
    const service = new PersonalizationService(
      { findById } as never,
      { getSelfIdentity: jest.fn(async () => ({ entityId: 'self-1', aliases: [] })) } as never,
    );

    return { service, findById };
  }

  it('serves a repeat read from its cache', async () => {
    const { service, findById } = serviceReading(['hands_off', 'cautious']);

    expect((await service.getProfile('user-1')).trustMode).toBe('hands_off');
    expect((await service.getProfile('user-1')).trustMode).toBe('hands_off');
    expect(findById).toHaveBeenCalledTimes(1);
  });

  it('reads the stored dial again when asked for a fresh profile, and refreshes the cache', async () => {
    const { service, findById } = serviceReading(['hands_off', 'cautious']);

    await service.getProfile('user-1');

    expect((await service.getProfile('user-1', { fresh: true })).trustMode).toBe('cautious');
    expect((await service.getProfile('user-1')).trustMode).toBe('cautious');
    expect(findById).toHaveBeenCalledTimes(2);
  });
});
