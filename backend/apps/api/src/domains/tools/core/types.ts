/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';
import type { ApiKeyCapability } from '@ci/common/decorators';

/**
 * JSON Schema definition for tool parameters
 */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: any[];
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  default?: any;
  anyOf?: JSONSchema[];
  additionalProperties?: boolean | JSONSchema;
}

/**
 * Example usage of a tool for documentation and testing
 */
export interface ToolExample {
  input: Record<string, any>;
  output: any;
  description: string;
}

// ── Intent capability vocabulary ─────────────────────────────────────────────
//
// Every tool IS an intent: a curated, domain-separated, privacy-labelled action.
// The intent metadata lives directly on the tool's schema (an {@link IntentDefinition}),
// co-located with its implementation — there is no separate catalog or wrapper.

/**
 * CI Schema Domains — the standardized verb vocabulary. Every tool belongs to exactly one
 * domain so agents and apps speak the same language ("memory.*", "people.*", …).
 */
export type IntentDomainKey = 'memory' | 'knowledge' | 'people' | 'places' | 'calendar' | 'media';

/** What an intent does to the user's data. Drives confirmation/guardrails. */
export type IntentAccess = 'read' | 'write' | 'delete';

/** How sensitive the data an intent touches is. */
export type IntentSensitivity = 'low' | 'personal' | 'sensitive';

/**
 * Per-tool privacy + safety label. A dispatcher uses `destructive` to require confirmation and
 * `external` to warn when an action leaves the appliance (CI's whole pitch is local data
 * ownership).
 *
 * These are not advisory hints. `access` and `destructive` are enforced on every execution by
 * {@link capabilityAllows}, called from `ToolRegistry.executeTool` — the one chokepoint every
 * dispatcher goes through. `destructive` and `external` additionally decide, via
 * {@link resolveDispatch}, whether an intent may run in the on-device tier at all.
 */
export interface IntentPrivacy {
  access: IntentAccess;
  sensitivity: IntentSensitivity;
  /** Irreversible / data-removing — a dispatcher should confirm before running. */
  destructive: boolean;
  /** Touches a third-party service / sends data off the appliance. */
  external: boolean;
}

/**
 * The canonical CI entity types — the typed content objects tools consume and produce, mirroring
 * the `ci.*` schema and the GraphQL types exposed to clients.
 */
export type CiEntityType =
  | 'event'
  | 'content'
  | 'person'
  | 'place'
  | 'communication'
  | 'note'
  | 'file'
  | 'item'
  | 'concept'
  | 'browser-activity';

/**
 * The schema for a tool — what the LLM sees, plus the curated intent metadata that makes it a
 * discoverable, privacy-labelled capability. Declared inline on each tool class next to its
 * implementation, so definition and behaviour live together.
 *
 * `name` is the canonical dotted semantic id (e.g. `memory.recall`). Because LLM
 * function-calling / MCP tool names must match `^[a-zA-Z0-9_-]+$`, the *executable* name is
 * derived by {@link intentToolName} (dots → underscores) at the registry / MCP / LLM boundary.
 */
export interface IntentDefinition {
  /** Canonical dotted id, e.g. `memory.recall`. Unique across the catalog. */
  name: string;
  domain: IntentDomainKey;
  /** Human-facing action title. */
  title: string;
  description: string;
  parameters: JSONSchema;
  privacy: IntentPrivacy;
  /**
   * Whether this intent can genuinely be served by the on-device (local) tier.
   *
   * True when the intent reads or writes **only the user's own data** — the corpus that is (or can
   * be) mirrored onto the device — and needs neither a third-party service nor a server-only
   * inference pipeline. A locally-ranked answer may be *worse* than the appliance's (no pgvector
   * re-ranking, a partial mirror) without making the intent un-servable; "needs the network to
   * answer at all" is what makes it false.
   *
   * Deliberately separate from `privacy.external`: external says the action *leaves* the
   * appliance, localCapable says the device *can stand in for* the appliance. They agree that
   * `media.streamingAvailability` is not local (it needs live TMDB), but they answer different
   * questions — `persona.compose` sends nothing outside yet is still not local, because the
   * multi-stage compose pipeline lives on the server.
   *
   * Required, not optional: an unlabelled intent would default to some guess, and both possible
   * guesses are wrong — `true` silently promises offline behaviour that does not exist, `false`
   * silently removes an intent from the offline surface. Boot-time validation in
   * ToolsRegistrationService additionally rejects the one incoherent combination
   * (`localCapable && privacy.external`).
   *
   * This is a *capability* claim, not a *permission*: whether a local dispatcher may actually run
   * it is {@link resolveDispatch}'s answer, which also refuses destructive/external intents.
   */
  localCapable: boolean;
  /** Entity types this tool reads. */
  consumes?: CiEntityType[];
  /** Entity types this tool returns. */
  produces?: CiEntityType[];
  /** Natural-language triggers (suggested phrasings). */
  phrases?: string[];
  examples?: ToolExample[];
  category?: string;
}

/**
 * The schema a tool exposes. Tools are intents, so the schema IS an {@link IntentDefinition};
 * this alias keeps the generic "tool schema" name available to the registry/providers.
 */
export type ToolSchema = IntentDefinition;

/**
 * Derive the executable tool name from a dotted intent id. Dots are not allowed in OpenAI/MCP
 * tool names, so `memory.recall` → `memory_recall`. Identity for names without dots.
 */
export function intentToolName(intentName: string): string {
  return intentName.replace(/\./g, '_');
}

/**
 * Standardized error information for tools
 */
export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, any>;
}

/**
 * Result of tool execution
 */
export interface ToolResult<T = any> {
  success: boolean;
  data?: T;
  error?: ToolError;
  executionTimeMs?: number;
  metadata?: Record<string, any>;
}

/**
 * Execution context passed to tools with tracing info
 */
export interface ToolExecutionContext extends RequestContext {
  toolName: string;
  executionId: string;
  startTime: Date;
}

/**
 * What a dispatcher must state to run a tool: the request context plus the **authority of the
 * principal on whose behalf the call is made**.
 *
 * `capability` is required rather than optional, and that is the whole point. Enforcement used to
 * live in `McpToolService` alone, so the transport decided whether the privacy label meant
 * anything: the LLM dispatcher called `ToolRegistry.executeTool` with a bare `RequestContext` and
 * a prompt-injected chat message could reach `memory.forget` unchecked. Making the field
 * mandatory means a new dispatcher cannot reach the registry by *forgetting* to authorize — it
 * has to name a level, in code, where a reviewer can see it.
 *
 * Use {@link ApiKeyCapability}'s `'full'` for in-process/system callers (background jobs, the
 * appliance acting as itself); anything driven by an outside caller must pass that caller's real
 * capability, e.g. `apiKeyCapabilityOf(req)`.
 */
export interface ToolInvocationContext extends RequestContext {
  capability: ApiKeyCapability;
}
