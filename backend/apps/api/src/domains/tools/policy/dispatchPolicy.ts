/**
 * The tier rule — "may this intent run HERE?". **Defined in `@ci/tool-core`; re-exported here.**
 *
 * It is published to the on-device dispatcher through the intent manifest precisely so there is
 * one rule rather than one per platform, which is the same argument for it living in a package
 * rather than inside the Nest application. See the package for the precedence that makes
 * capability-before-tier load-bearing.
 */
export {
  DISPATCH_TIERS,
  resolveDispatch,
  type DispatchDecision,
  type DispatchOptions,
  type DispatchReason,
  type DispatchRuling,
  type DispatchTier,
  type DispatchableIntent,
} from '@ci/tool-core';
