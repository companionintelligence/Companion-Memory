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

  it('keeps the documented environment names', () => {
    expect(DECISION_FLAGS).toEqual({
      memoryIngress: 'MEMORY_INGRESS_DECISION',
      searchRerank: 'SEARCH_TRAINED_RERANK',
      planningCommitment: 'PLANNING_COMMITMENT_DECISION',
    });
  });
});
