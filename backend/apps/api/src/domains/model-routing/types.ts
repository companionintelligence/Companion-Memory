/**
 * Model-tier routing — the on-device ↔ private-cloud escalation decision.
 *
 * CI runs a local model (Ollama) by default — private, offline, smaller context.
 * Some tasks (large context, deeper reasoning, long tool chains) need more than the
 * local tier can give; today a harness's only "escalation" is leaking the raw
 * prompt to a third-party API.
 *
 * This module makes the escalation a *decision*: given a task's characteristics,
 * choose the cheapest tier that can handle it — and, crucially for a data-ownership
 * product, let privacy *pin* a task on-device even when a bigger model would help.
 */

/** The two compute tiers. */
export type ModelTier = 'on_device' | 'private_cloud';

/** Reasoning effort for a task. */
export type ReasoningLevel = 'light' | 'moderate' | 'deep';

/** Static capability profile of a tier. */
export interface TierProfile {
  tier: ModelTier;
  title: string;
  /** Usable context window in tokens. */
  maxContextTokens: number;
  /** Works without network connectivity. */
  offline: boolean;
  /** Leaves the appliance (sends data to a third party / the cloud). */
  external: boolean;
  description: string;
}

/** What the caller knows about the task to be run. */
export interface RoutingRequest {
  /** Rough size of the prompt + context the task needs. */
  estimatedInputTokens?: number;
  /** Requested reasoning effort. */
  reasoningLevel?: ReasoningLevel;
  /** Expected depth of sequential tool calls (agentic chains get harder). */
  toolDepth?: number;
  /** Caller asserts the task needs a large context window. */
  requiresLargeContext?: boolean;
  /**
   * Privacy pin: this task must NOT leave the appliance, even if that means a
   * weaker on-device model. Set this for sensitive data (mirrors the
   * `IntentPrivacy` sensitivity/external labels in the intent catalog).
   */
  localOnly?: boolean;
  /** Whether the escalated (private-cloud) tier is currently reachable. */
  cloudAvailable?: boolean;
  /** Hard override of the chosen tier (still subject to `localOnly`). */
  forceTier?: ModelTier;
}

/** The routing outcome. */
export interface RoutingDecision {
  tier: ModelTier;
  reasoningLevel: ReasoningLevel;
  profile: TierProfile;
  /** Human-readable reasons the tier was chosen (for logs + transparency). */
  reasons: string[];
  /**
   * True when the task wanted the escalated tier but was kept on-device — because
   * of `localOnly` (privacy) or because the cloud tier was unavailable. Signals
   * the answer may be context-truncated or lower quality.
   */
  downgraded: boolean;
}
