/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ToolCapability } from '../capability';
import type { ToolRequestContext } from '../context';

/**
 * Where an intent is being dispatched from.
 *
 * Canonical home for this type: `core/types.ts` is foundational to every `policy/*` module
 * (dispatchPolicy and capabilityPolicy both import intent types from here), so defining it here
 * — rather than in `policy/dispatchPolicy.ts`, which then re-exports it — keeps that dependency
 * one-directional. The reverse used to be a type-only import, which avoids a RUNTIME cycle but
 * not the module-graph one `no-circular` checks.
 *
 * - `appliance` — the CI-Server itself: full corpus, network, and the user's own authority.
 * - `local` — the on-device tier (the mobile Local Hub sidecar / on-device model), running against
 *   a partial mirror, possibly offline, and with no way to ask the appliance anything right now.
 */
export const DISPATCH_TIERS = ['appliance', 'local'] as const;

export type DispatchTier = (typeof DISPATCH_TIERS)[number];

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
export type IntentDomainKey =
  | 'memory'
  | 'knowledge'
  | 'people'
  | 'places'
  | 'calendar'
  | 'media'
  | 'import'
  | 'forecast'
  | 'brief'
  | 'insights'
  | 'anomalies'
  | 'suggestions'
  | 'messaging'
  | 'mcp'
  | 'planning';

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
 * {@link capabilityAllows}, called from `ToolRegistryCore.executeTool` — the one chokepoint every
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
  | 'browser-activity'
  | 'task';

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
  /**
   * The user this tool belongs to, when it is not a capability of the appliance itself.
   *
   * Absent on every native intent — `memory.recall` is the same tool for everyone, and the tool
   * scopes its own reads by the caller's `context.userId`. Set only by a provider whose tools are
   * materialized from ONE user's stored configuration and carry that user's credentials: today
   * exactly the MCP-client provider, where a tool is a bound call into a server that a specific
   * user configured, authenticated with the secrets that user saved.
   *
   * The {@link ToolRegistryCore} is a process-global map keyed by tool name, so without this field
   * a tool built from one user's config is listed to — and executable by — every other account on
   * the appliance. `getAvailableTools` hides an owned tool from anyone but its owner, and
   * `executeTool` refuses it, so ownership is enforced rather than merely advertised.
   *
   * The owner may also be decided at runtime. The `messaging.*` intents are native tools, but
   * they act on the one BlueBubbles connector, which belongs to whichever account an
   * administrator connected it for; they expose `schema` as a getter that reads that owner on
   * every access. So the registry reads this field when it decides, never once at registration,
   * and anything that snapshots schemas (MCP's tool map) has to ask
   * `ToolRegistryCore.isToolVisibleTo` per request.
   */
  ownerUserId?: string;
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
 * Map names Qwen invents onto the executable catalog. `memory_create_relationships`
 * is not a tool; the write path is still `memory_remember`.
 */
export function canonicalizeExecutableToolName(name: string): string {
  const underscored = intentToolName(name);
  const mashed = name.replace(/[_.-]/g, '').toLowerCase();

  if (mashed === 'memoryremember' || mashed === 'memorycreaterelationships') {
    return 'memory_remember';
  }

  return underscored;
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
export interface ToolExecutionContext extends ToolRequestContext {
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
 * anything: the LLM dispatcher called `ToolRegistry.executeTool` with a bare request context and
 * a prompt-injected chat message could reach `memory.forget` unchecked. Making the field
 * mandatory means a new dispatcher cannot reach the registry by *forgetting* to authorize — it
 * has to name a level, in code, where a reviewer can see it.
 *
 * Use {@link FULL_CAPABILITY} for in-process/system callers (background jobs, the appliance
 * acting as itself); anything driven by an outside caller must pass that caller's real
 * capability, e.g. `apiKeyCapabilityOf(req)`.
 */
/**
 * The kinds of caller the gate distinguishes.
 *
 * Deliberately two values, not a principal object: the only question the policy
 * asks is "is this the owner, or something the owner installed?". Anything
 * finer belongs in the ledger and the approval card, not in the rule.
 */
export const TOOL_PRINCIPALS = ['owner', 'managed-app'] as const;

/**
 * Derived from {@link TOOL_PRINCIPALS} rather than written twice: a reader that
 * validates `?principal=` needs the values at runtime, and two hand-kept lists
 * is how a third value gets added to one of them.
 */
export type ToolPrincipal = (typeof TOOL_PRINCIPALS)[number];

export interface ToolInvocationContext extends ToolRequestContext {
  capability: ToolCapability;
  /**
   * Which tier this call is being dispatched from. Defaults to `'appliance'` —
   * the server acting as itself, which is every in-process dispatcher.
   *
   * A caller that names `'local'` is telling the appliance the request
   * originated on the on-device tier, which is what makes `resolveDispatch`'s
   * three `queue` reasons reachable at this chokepoint: the device may be able
   * to REACH the appliance and still be the wrong place to have confirmed a
   * deletion or an outbound message. `IntentsController` accepts it as
   * `?tier=local` on the execute route, the same vocabulary the manifest route
   * already publishes rulings under.
   */
  tier?: DispatchTier;
  /**
   * WHO is calling, where capability says only what they may do.
   *
   * `'managed-app'` is an installed harness (CI-OpenClaw, CI-Hermes) acting on
   * the owner's behalf, established from `api_keys.managed_by` and never from a
   * key's name. Everything else — a session, a Portal token, the owner's own
   * api key, an in-process dispatcher — is `'owner'`, which is also the default
   * when unset, so no existing caller changes behaviour by omission.
   *
   * Load-bearing because capability CANNOT express it: an owner's hand-made key
   * and a connect-minted harness key can carry identical scopes and identical
   * authority. The owner's trust dial is an owner convenience; it should not be
   * what decides whether a BORROWED agent is confirmed before doing something
   * irreversible.
   */
  principal?: ToolPrincipal;
  /**
   * Which installed app, when {@link ToolInvocationContext.principal} is
   * `'managed-app'` — the api-key name, for naming it on an approval card.
   * Ignored for an owner principal.
   */
  principalName?: string | null;

  /**
   * The `ci.pending_actions` row this call is the confirmed replay of.
   *
   * NOT a bearer token: the gate re-reads the row and honours it only if it
   * exists, belongs to `userId`, and is `approved`. It never affects the
   * capability check, which runs first and unconditionally.
   */
  pendingActionId?: string;
}
