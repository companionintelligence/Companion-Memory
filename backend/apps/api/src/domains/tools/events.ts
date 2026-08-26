import type { ApiKeyCapability } from '@ci/common/decorators';
import { defineEvent } from '@ci/domains/events';

import type { IntentAccess, IntentDomainKey } from './core/types';

/**
 * Event emitted for every tool (intent) invocation — a behavioral signal for prediction/HBPE, and
 * the row source for the `ci.tool_invocations` ledger.
 *
 * Every tool is an intent, so this fires once per {@link ToolRegistry.executeTool} — including the
 * calls the capability check REFUSED (see {@link ToolInvocationOutcome}) — carrying the curated
 * identity + privacy facets of the invoked capability. It is emitted on the durable
 * {@link EventService} (like `agent-memory.created`) rather than the raw in-process emitter, and
 * routed to the `telemetry` queue.
 *
 * The payload carries NO tool input and NO tool output. See migration
 * `20260826202414_create_tool_invocations.sql` for why: a record that keeps every payload forever
 * is a second copy of the user's content with none of the deletion paths the first copy has.
 *
 * @see {@link ToolInvokedListener} - registers the `telemetry` queue and persists the signal.
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

/** Payload of {@link ToolInvokedEvent}. */
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
  /** `RequestContext.traceId` — joins the row to the request's log lines. */
  correlationId?: string;
  /** WHICH api key authenticated (`ci.api_keys.id`). Absent for session/JWT and in-process callers. */
  apiKeyId?: string;
  /** The authority the caller stated. Paired with `outcome: 'refused'`, the whole story. */
  capability?: ApiKeyCapability;
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

defineEvent<ToolInvokedPayload>(ToolInvokedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ToolInvokedEvent]: ToolInvokedPayload;
  }
}
