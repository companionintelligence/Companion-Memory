/**
 * `@ci/tool-core` — the transport- and framework-independent core of CI's tool/intent system.
 *
 * CI-Server's API is one NestJS application holding 54 domains, and `domains/tools` is the one
 * three separate frontends need: the MCP server (`domains/mcp`), the in-house LLM dispatcher, and
 * eventually a CLI. Before this package existed only the in-process ones could reach it, and the
 * consequence was not theoretical — the privacy label was enforced in `McpToolService` alone, so
 * whether it meant anything depended on which door a caller came through.
 *
 * What lives here is exactly what all three need and none of them should re-implement:
 *
 * - the **vocabulary**: {@link IntentDefinition} and the {@link JSONSchema} it carries,
 *   {@link ToolResult}, {@link ToolInvocationContext}, {@link intentToolName}.
 * - the **policy**: {@link capabilityAllows}, {@link resolveDispatch}, {@link resolveToolGate} —
 *   one implementation of "may this caller run this intent, here, now?".
 * - the **registry**: {@link ToolRegistryCore}, the single chokepoint that applies that policy on
 *   every execution.
 *
 * What deliberately does NOT live here: the 33 tools themselves (each is a thin wrapper over
 * another domain's services), `BaseTool`, the pending-action table, the intent catalog service,
 * and every Nest module, controller and entity. There is not a single `@nestjs/*` import in this
 * package, and `tsconfig.json` turns decorator support off so that stays true by construction.
 *
 * @module @ci/tool-core
 */

export {
  FULL_CAPABILITY,
  READ_CAPABILITY,
  TOOL_CAPABILITIES,
  WRITE_CAPABILITY,
  type ToolCapability,
} from './capability';
export type { ToolRequestContext } from './context';
export type { ToolCoreLogger } from './logging';

export { coerceArgumentsToSchema } from './core/coerceArguments';
export type { ToolHandle } from './core/ToolHandle';
export {
  DISPATCH_TIERS,
  TOOL_PRINCIPALS,
  canonicalizeExecutableToolName,
  intentToolName,
  type CiEntityType,
  type DispatchTier,
  type IntentAccess,
  type IntentDefinition,
  type IntentDomainKey,
  type IntentPrivacy,
  type IntentSensitivity,
  type JSONSchema,
  type ToolError,
  type ToolExample,
  type ToolExecutionContext,
  type ToolInvocationContext,
  type ToolPrincipal,
  type ToolResult,
  type ToolSchema,
} from './core/types';

export {
  TOOL_INVOCATION_ERROR_MAX_LENGTH,
  TOOL_INVOCATION_OUTCOMES,
  ToolInvokedEvent,
  type ToolInvocationOutcome,
  type ToolInvokedPayload,
} from './events';

export {
  capabilityAllows,
  capabilityRequiredFor,
  needsConfirmation,
  removesData,
  resolveDispatch,
  resolveToolGate,
  type DispatchDecision,
  type DispatchOptions,
  type DispatchReason,
  type DispatchRuling,
  type DispatchableIntent,
  type GatedPrivacy,
  type ToolGateOptions,
  type ToolGateReason,
  type ToolGateRuling,
  type TrustDecision,
} from './policy';

export type { ProviderHealthStatus, ToolProvider } from './providers/ToolProvider';

export { ToolRegistryCore, outcomeOf } from './registry/ToolRegistry';
export type { ProposedAction, ToolGate, ToolInvocationSink } from './registry/ports';
