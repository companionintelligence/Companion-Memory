import type { ToolCapability } from './capability';
import type { DispatchTier, IntentAccess, IntentDomainKey, ToolPrincipal } from './core/types';

/**
 * Event emitted for every tool (intent) invocation — a behavioral signal for prediction/HBPE, and
 * the row source for the `ci.tool_invocations` ledger.
 *
 * Every tool is an intent, so this fires once per {@link ToolRegistryCore.executeTool} — including
 * the calls the capability check REFUSED (see {@link ToolInvocationOutcome}) — carrying the
 * curated identity + privacy facets of the invoked capability.
 *
 * The name and the payload live here; the *delivery* does not. The API registers this name with
 * its durable event bus (`domains/tools/events.ts` calls `defineEvent` and routes it to the
 * `telemetry` queue), because `defineEvent` belongs to the events domain and would drag the whole
 * Nest module graph into this package. What crosses the boundary is a
 * {@link ToolInvocationSink}: the registry hands it a payload, and the frontend decides what
 * "emit" means.
 *
 * The payload carries NO tool input and NO tool output. See migration
 * `20260826202414_create_tool_invocations.sql` for why: a record that keeps every payload forever
 * is a second copy of the user's content with none of the deletion paths the first copy has.
 */
export const ToolInvokedEvent = 'tool.invoked';

/** The four ways a tool call can end. Mirrors the CHECK on `ci.tool_invocations.outcome`. */
export const TOOL_INVOCATION_OUTCOMES = ['success', 'error', 'timeout', 'refused'] as const;

/**
 * How the call ended.
 *
 * - `success` — the tool ran and returned success.
 * - `error` — the tool ran and returned (or threw) a failure.
 * - `timeout` — the failure was a deadline rather than a defect. Split out from `error` because
 *   the two need different operator responses, and a timeout in a chat turn is invisible in a log
 *   tail once the turn scrolls away.
 * - `refused` — the capability check denied the call and **nothing ran**. This is the value that
 *   makes the refusal branch safe to emit at all: the reason it was previously left silent is that
 *   feeding a refusal into the behavioral signal would teach prediction the user did the thing,
 *   and a consumer can now filter `outcome <> 'refused'` to get exactly the old behaviour — while
 *   an operator, for whom a denied call is the single most interesting row in the table, can see
 *   it.
 */
export type ToolInvocationOutcome = (typeof TOOL_INVOCATION_OUTCOMES)[number];

/** Longest `error` the ledger stores. Enforced again by a CHECK on the column. */
export const TOOL_INVOCATION_ERROR_MAX_LENGTH = 500;

/**
 * Payload of {@link ToolInvokedEvent}.
 *
 * A `type` and not an `interface`, deliberately: the API's `defineEvent<T extends
 * Record<string, unknown>>` only accepts the former, because an interface has no implicit index
 * signature.
 */
export type ToolInvokedPayload = {
  /** Dotted intent id, e.g. `memory.recall`. The GraphQL operation name on the GraphQL plane. */
  intent: string;
  /** Executable tool name, e.g. `memory_recall`. */
  tool: string;
  /** Absent on the GraphQL-over-MCP plane, which has no domain vocabulary. */
  domain?: IntentDomainKey;
  /**
   * Which plane served the call: the registry provider name (`native`, `mcp-client`, …), or
   * `graphql` for the GraphQL-over-MCP path that does not go through the registry at all.
   */
  source: string;
  userId?: string;
  /** `ToolRequestContext.traceId` — joins the row to the request's log lines. */
  correlationId?: string;
  /** WHICH api key authenticated (`ci.api_keys.id`). Absent for session/JWT and in-process callers. */
  apiKeyId?: string;
  /** The authority the caller stated. Paired with `outcome: 'refused'`, the whole story. */
  capability?: ToolCapability;
  /**
   * WHO called, where {@link ToolInvokedPayload.capability} says only what they
   * were allowed to do.
   *
   * The registry had this on the context and did not record it, so the ledger
   * could say a call with `full` authority deleted something and never which of
   * the owner and an installed harness made it — the distinction the whole
   * managed-app gate is built on. Absent on rows written before it was carried,
   * and on any dispatcher that does not state a principal.
   */
  principal?: ToolPrincipal;
  /**
   * Which installed app, when {@link ToolInvokedPayload.principal} is
   * `'managed-app'` — the api-key name (`app:ci-openclaw:ci-marketplace`).
   *
   * Stores the name, not a display label, for the same reason
   * `ci.pending_actions.principal_name` does: the row records the fact and the
   * reader does the presentation.
   */
  principalName?: string;
  /**
   * Which tier served the call. Absent reads as `appliance` — the documented
   * default of {@link ToolInvocationContext.tier}, so a NULL is the default left
   * unwritten rather than a missing fact.
   *
   * Worth a column because `resolveDispatch`'s queue reasons are all
   * tier-dependent: the same intent from `local` and from `appliance` are two
   * different rulings, and a ledger that flattens them cannot explain either.
   */
  tier?: DispatchTier;
  /** ISO-8601 instant the call ended. */
  occurredAt: string;
  outcome: ToolInvocationOutcome;
  /** `ToolError.code`, e.g. `TOOL_FORBIDDEN`. */
  errorCode?: string;
  /** `ToolError.message`, truncated to {@link TOOL_INVOCATION_ERROR_MAX_LENGTH}. */
  error?: string;
  durationMs?: number;
  access?: IntentAccess;
  /** True if the invoked tool touches a third-party service. */
  external: boolean;
  /** True if the invoked tool is irreversible / data-removing. */
  destructive: boolean;
};
