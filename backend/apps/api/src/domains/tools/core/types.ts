/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';

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
