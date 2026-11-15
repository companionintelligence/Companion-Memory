import { DECISION_FLAGS, isDecisionFlagOn } from '../decisionFlags';

describe('isDecisionFlagOn', () => {
  it('is off for every decision flag when the environment does not set it', () => {
    for (const name of Object.values(DECISION_FLAGS)) {
      expect(isDecisionFlagOn(name, {})).toBe(false);
    }
  });

  it('is on only for "true" or "1", trimmed and case-insensitive', () => {
    const name = DECISION_FLAGS.memoryIngress;

    expect(isDecisionFlagOn(name, { [name]: 'true' })).toBe(true);
    expect(isDecisionFlagOn(name, { [name]: ' TRUE ' })).toBe(true);
    expect(isDecisionFlagOn(name, { [name]: '1' })).toBe(true);
  });

  it('stays off for any other value', () => {
    const name = DECISION_FLAGS.searchRerank;

    for (const value of ['', '0', 'false', 'yes', 'on', 'truthy']) {
      expect(isDecisionFlagOn(name, { [name]: value })).toBe(false);
    }
  });

  it('turns on only the flag whose variable is set', () => {
    const env = { SEARCH_TRAINED_RERANK: 'true' };

    expect(isDecisionFlagOn(DECISION_FLAGS.searchRerank, env)).toBe(true);
    expect(isDecisionFlagOn(DECISION_FLAGS.memoryIngress, env)).toBe(false);
    expect(isDecisionFlagOn(DECISION_FLAGS.planningCommitment, env)).toBe(false);
    expect(isDecisionFlagOn(DECISION_FLAGS.memoryIngress, { MEMORY_INGRESS_DECISION: '1' })).toBe(true);
    expect(
      isDecisionFlagOn(DECISION_FLAGS.planningCommitment, { PLANNING_COMMITMENT_DECISION: 'TRUE' }),
    ).toBe(true);
  });
});
