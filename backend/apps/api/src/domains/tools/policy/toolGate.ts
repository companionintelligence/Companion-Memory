import type { PersonalizationDecision } from '@ci/domains/personalization/types';
import type { TrustDecision } from '@ci/tool-core';

import type { Assert, Identical } from '../toolCoreContract';

/**
 * The confirmation gate. **Defined in `@ci/tool-core`; re-exported here.**
 *
 * `ToolGateOptions.trust` is typed in the package as `TrustDecision`, which is this application's
 * `PersonalizationDecision` restated — the dial belongs to the personalization domain, and that
 * domain is Nest services all the way down. The assertion below is what lets
 * `PersonalizationService.decide`'s answer keep going straight into `resolveToolGate`: a mode
 * added to the dial without a matching branch in the gate becomes a compile error here rather than
 * a queue decision nobody wrote.
 */
export type TrustDialIsShared = Assert<Identical<PersonalizationDecision, TrustDecision>>;

export {
  needsConfirmation,
  resolveToolGate,
  type ToolGateOptions,
  type ToolGateReason,
  type ToolGateRuling,
} from '@ci/tool-core';
