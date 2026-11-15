import { defaultDecisionClient } from './decisionClient';
import { DECISION_FLAGS, isDecisionFlagOn } from './decisionFlags';

/**
 * The HBPE `is_commitment` verdict for a planning message that the System 1
 * pre-filter could not decide (no pre-filter, or it failed).
 *
 * Resolves to `undefined` when `PLANNING_COMMITMENT_DECISION` is off, and makes
 * no request then. It is also `undefined` when the sidecar gave no answer. In
 * both cases the caller keeps its current outcome.
 */
export async function planningCommitmentSignal(userId: string, text: string): Promise<boolean | undefined> {
  if (!isDecisionFlagOn(DECISION_FLAGS.planningCommitment)) {
    return undefined;
  }

  const decision = await defaultDecisionClient().ingress(userId, text);

  return decision?.is_commitment;
}
