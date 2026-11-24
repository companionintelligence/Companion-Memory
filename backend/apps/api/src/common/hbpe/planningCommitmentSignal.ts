import { defaultDecisionClient } from './decisionClient';
import { DECISION_FLAGS, isDecisionFlagOn } from './decisionFlags';

/**
 * The `threshold` the planning callers pass to the System 1 pre-filter. The
 * pre-filter (`ContrastiveDecisionService.scoreIngressCommitment`) calls a message
 * a commitment when HBPE sets `is_commitment` or `commitment_probability` reaches
 * this value, and the signal below applies the same rule.
 */
export const PLANNING_COMMITMENT_THRESHOLD = 0.25;

/**
 * Whether HBPE counts a planning message as a commitment, for one the System 1
 * pre-filter could not decide (no pre-filter, or it threw).
 *
 * Resolves to `true` or `false` by the pre-filter's rule, and to `undefined` when
 * `PLANNING_COMMITMENT_DECISION` is off or the sidecar gave no answer. In both
 * cases the caller keeps its current outcome. It never throws.
 */
export async function planningCommitmentSignal(userId: string, text: string): Promise<boolean | undefined> {
  if (!isDecisionFlagOn(DECISION_FLAGS.planningCommitment)) {
    return undefined;
  }

  try {
    const decision = await defaultDecisionClient().ingress(userId, text);

    if (!decision) {
      return undefined;
    }

    return decision.is_commitment || decision.commitment_probability >= PLANNING_COMMITMENT_THRESHOLD;
  } catch {
    return undefined;
  }
}
