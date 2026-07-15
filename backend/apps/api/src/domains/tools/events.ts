import { defineEvent } from '@ci/domains/events';

import type { IntentAccess, IntentDomainKey } from './core/types';

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

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ToolInvokedEvent]: ToolInvokedPayload;
  }
}
