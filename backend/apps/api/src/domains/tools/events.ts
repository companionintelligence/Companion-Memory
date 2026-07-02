import { defineEvent } from '@ci/domains/events';

import type { IntentAccess, IntentDomainKey, IntentSensitivity } from './core/types';

/**
 * Event emitted for every tool (intent) invocation — a behavioral signal for prediction/HBPE.
 *
 * Every tool is an intent, so this fires once per {@link ToolRegistry.executeTool}, carrying the
 * curated identity + privacy facets of the invoked capability. It is emitted on the durable
 * {@link EventService} (like `agent-memory.created`) rather than the raw in-process emitter, and
 * routed to the `telemetry` queue.
 *
 * @see {@link ToolInvokedListener} - registers the `telemetry` queue and consumes the signal.
 */
export const ToolInvokedEvent = 'tool.invoked';

/** Payload of {@link ToolInvokedEvent}. */
export type ToolInvokedPayload = {
  /** Dotted intent id, e.g. `memory.recall`. */
  intent: string;
  /** Executable tool name, e.g. `memory_recall`. */
  tool: string;
  domain: IntentDomainKey;
  userId?: string;
  success: boolean;
  durationMs?: number;
  access: IntentAccess;
  /** True if the invoked tool touches a third-party service. */
  external: boolean;
};

defineEvent<ToolInvokedPayload>(ToolInvokedEvent);

// ── Intent authorization audit trail ─────────────────────────────────────────
//
// The enforcing dispatcher ({@link IntentDispatcherService}) emits exactly one of these per
// gated invocation, *before* the tool runs. Unlike `tool.invoked` (a post-hoc behavioral signal
// for HBPE), these are the security audit trail that Bet 2 ("trust as the product") rests on:
// every `destructive` / `external` action produces a durable authorized/denied record.

/** Emitted when the dispatcher permits an intent to execute. */
export const IntentAuthorizedEvent = 'intent.authorized';

/** Emitted when the dispatcher blocks an intent (e.g. default-deny on destructive). */
export const IntentDeniedEvent = 'intent.denied';

/** The execution surface the intent arrived on — which caller invoked the dispatcher. */
export type IntentSurface = 'native' | 'mcp' | 'graphql';

/** Fields shared by both authorization audit events. */
type IntentDecisionBase = {
  /** Dotted intent id, e.g. `memory.forget`. */
  intent: string;
  /** Executable tool name, e.g. `memory_forget`. */
  tool: string;
  domain?: IntentDomainKey;
  userId?: string;
  surface: IntentSurface;
  access: IntentAccess;
  sensitivity: IntentSensitivity;
  destructive: boolean;
  external: boolean;
};

/** Payload of {@link IntentAuthorizedEvent}. */
export type IntentAuthorizedPayload = IntentDecisionBase & {
  /** True when the intent was allowed but carries a caution (e.g. leaves the appliance). */
  warned: boolean;
};

/** Payload of {@link IntentDeniedEvent}. */
export type IntentDeniedPayload = IntentDecisionBase & {
  /** Machine-readable denial reason, e.g. `destructive_denied_by_policy`. */
  reason: string;
};

defineEvent<IntentAuthorizedPayload>(IntentAuthorizedEvent);
defineEvent<IntentDeniedPayload>(IntentDeniedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ToolInvokedEvent]: ToolInvokedPayload;
    [IntentAuthorizedEvent]: IntentAuthorizedPayload;
    [IntentDeniedEvent]: IntentDeniedPayload;
  }
}
