import type { IntentDefinition, ToolInvocationContext } from '../core/types';
import type { ToolInvokedPayload } from '../events';
import type { ToolGateRuling } from '../policy/toolGate';

/**
 * Where a completed (or refused) invocation goes.
 *
 * The registry's job is to decide WHAT the ledger row says; deciding what "emit" means is the
 * frontend's. The API implements this by sending {@link ToolInvokedEvent} on its durable pg-boss
 * bus routed to the `telemetry` queue; a CLI could append a line to a file, or drop it.
 *
 * Never throws in practice — {@link ToolRegistryCore.recordInvocation} swallows and logs — because
 * a telemetry failure must not fail an already-completed tool call.
 */
export interface ToolInvocationSink {
  record(payload: ToolInvokedPayload): Promise<unknown>;
}

/**
 * The confirmation queue, as the registry needs it.
 *
 * Implemented in the API by `PendingActionService`, which is a Nest provider over a TypeORM
 * repository and a feature flag — none of which the registry has any business knowing about. What
 * it does need is the two-question protocol: may this run (`evaluate`), and if not, park it and
 * give me something to hand back (`propose`).
 *
 * A frontend with no durable queue can supply a gate whose `evaluate` always returns `execute`;
 * `propose` is then unreachable.
 */
export interface ToolGate {
  evaluate(schema: IntentDefinition, context: ToolInvocationContext): Promise<ToolGateRuling>;

  propose(
    schema: IntentDefinition,
    toolName: string,
    context: ToolInvocationContext & { userId: string },
    input: unknown,
    ruling: ToolGateRuling,
  ): Promise<ProposedAction>;
}

/** The parked proposal a caller is handed so it can be approved later. */
export interface ProposedAction {
  id: string;
  expiresAt?: Date | null;
}
