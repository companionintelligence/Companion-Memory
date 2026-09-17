import { defineEvent } from '@ci/domains/events';
import { ToolInvokedEvent, type ToolInvokedPayload } from '@ci/tool-core';

/**
 * The durable registration of `tool.invoked`, the behavioral signal every tool call donates and
 * the row source for the `ci.tool_invocations` ledger.
 *
 * The event's NAME, its payload and the outcome vocabulary live in `@ci/tool-core` — the registry
 * that stamps them is there, and a frontend outside this process has to be able to read a ledger
 * row without importing the events domain. What cannot move is this file's two remaining lines:
 * `defineEvent` belongs to `domains/events` and reaches the whole Nest module graph through it,
 * which is exactly the dependency the package is defined by not having.
 *
 * So the split is: the package says what a tool invocation IS, this file says how it is delivered
 * on this appliance (`EventService`, `queue: 'telemetry'`, see `registry/ToolRegistry.ts`).
 *
 * @see {@link ToolInvokedListener} - registers the `telemetry` queue and persists the signal.
 */
export {
  TOOL_INVOCATION_ERROR_MAX_LENGTH,
  TOOL_INVOCATION_OUTCOMES,
  ToolInvokedEvent,
  type ToolInvocationOutcome,
  type ToolInvokedPayload,
} from '@ci/tool-core';

defineEvent<ToolInvokedPayload>(ToolInvokedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ToolInvokedEvent]: ToolInvokedPayload;
  }
}
