/**
 * Default-off switches for the System 1 decision callers in the API.
 *
 * Each flag is read from the environment at the moment a caller needs it, never
 * cached at import, so a test (or a restart with a new environment) sees the
 * value it set. Only `true` or `1`, trimmed and case-insensitive, turns a flag
 * on. Anything else, including unset, leaves the caller on its current path.
 */
export const DECISION_FLAGS = {
  /** Score each memory write with HBPE `/decision/ingress`, recorded beside the write. */
  memoryIngress: 'MEMORY_INGRESS_DECISION',
  /** Re-order the head of an RRF search result by HBPE `/decision/rerank`. */
  searchRerank: 'SEARCH_TRAINED_RERANK',
  /** Use HBPE `is_commitment` where the planning pre-filter has no verdict. */
  planningCommitment: 'PLANNING_COMMITMENT_DECISION',
} as const;

export type DecisionFlagName = (typeof DECISION_FLAGS)[keyof typeof DECISION_FLAGS];

export function isDecisionFlagOn(name: DecisionFlagName, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name];

  if (raw == null) {
    return false;
  }

  const value = raw.trim().toLowerCase();

  return value === 'true' || value === '1';
}
