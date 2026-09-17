/**
 * Tool/intent execution policy — the rules that decide whether a given caller may run a given
 * intent, and in which tier.
 *
 * Pure functions with no framework wiring on purpose: they are called from the registry, from a
 * transport adapter (`McpToolService`), and are published as a rule the on-device dispatcher
 * follows via the intent manifest. Anything that needed injection would not be shareable across
 * all three — which is the whole reason this package exists.
 */
export { capabilityAllows, capabilityRequiredFor, removesData, type GatedPrivacy } from './capabilityPolicy';
export {
  DISPATCH_TIERS,
  resolveDispatch,
  type DispatchDecision,
  type DispatchOptions,
  type DispatchReason,
  type DispatchRuling,
  type DispatchTier,
  type DispatchableIntent,
} from './dispatchPolicy';
export {
  needsConfirmation,
  resolveToolGate,
  type ToolGateOptions,
  type ToolGateReason,
  type ToolGateRuling,
  type TrustDecision,
} from './toolGate';
