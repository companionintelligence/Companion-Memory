/**
 * CI Intent + Entity Schema — the semantic capability layer.
 *
 * CI historically exposed only raw GraphQL CRUD and ad-hoc native tools, with no
 * shared, curated, discoverable catalog of meaningful actions. This module adds
 * that catalog: a typed vocabulary of intents and the entity types they operate on.
 *
 * An {@link IntentDefinition} is a *curated semantic facade* over a capability
 * that already exists in CI-Server (a native tool today; GraphQL/search later).
 * Intents are grouped into {@link IntentDomain}s (the standardized vocabulary),
 * carry an {@link IntentPrivacy} label (so a dispatcher can gate destructive or
 * external actions), and reference the {@link CiEntityType}s they consume/produce.
 *
 * The whole catalog is published as an {@link IntentManifest} (REST + MCP) so any
 * agent — CI-Hermes, CI-OpenClaw, or an external MCP client — discovers the same
 * typed vocabulary instead of re-implementing bespoke integration glue.
 */

import type { JSONSchema } from '@ci/domains/tools';

/**
 * CI Schema Domains — the standardized verb vocabulary. Every intent belongs to
 * exactly one domain so agents and apps speak the same language ("memory.*",
 * "people.*", …) instead of inventing their own.
 */
export type IntentDomainKey = 'memory' | 'knowledge' | 'people' | 'places' | 'calendar' | 'media';

export interface IntentDomain {
  key: IntentDomainKey;
  title: string;
  description: string;
}

/** What an intent does to the user's data. Drives confirmation/guardrails. */
export type IntentAccess = 'read' | 'write' | 'delete';

/** How sensitive the data an intent touches is. */
export type IntentSensitivity = 'low' | 'personal' | 'sensitive';

/**
 * Per-intent privacy + safety label. A future dispatcher uses `destructive` to
 * require confirmation and `external` to warn when an action leaves the appliance
 * (CI's whole pitch is local data ownership).
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
 * The canonical CI entity types — the entity registry. These are the typed
 * content objects intents consume and produce, mirroring the `ci.*` schema and
 * the GraphQL types exposed to clients.
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
 * Display + identity descriptor for an entity type. Published in the manifest so
 * agents can render and resolve entities uniformly.
 */
export interface CiEntityDescriptor {
  type: CiEntityType;
  title: string;
  description: string;
  idKind: 'uuid' | 'global-uid';
}

/**
 * How an intent executes. Today every intent is a facade over an existing native
 * tool (proving the consolidation thesis: the catalog is a thin curated layer,
 * not a re-implementation). The union is open for `graphql` / `search` bindings.
 */
export type IntentBinding = {
  kind: 'native-tool';
  /** The `ToolSchema.name` of the underlying registered native tool. */
  tool: string;
  /**
   * Optional rename of intent params → underlying-tool params. Identity when
   * omitted (intent param names match the tool's).
   */
  argMap?: Record<string, string>;
  /**
   * Constant args merged into every call (caller args take precedence). Lets
   * several curated intents specialize one underlying tool — e.g. `people.find`
   * and `places.find` both bind `databaseSearch` with a fixed `entityTypes`
   * scope, so one search capability backs many distinct, discoverable intents.
   */
  fixedArgs?: Record<string, unknown>;
};

/**
 * A single typed action.
 *
 * `name` is the canonical dotted semantic id and vocabulary entry (e.g.
 * `memory.recall`). Because LLM function-calling / MCP tool names must match
 * `^[a-zA-Z0-9_-]+$`, the *executable* tool name is derived by
 * {@link intentToolName} (dots → underscores).
 */
export interface IntentDefinition {
  /** Canonical dotted id, e.g. `memory.recall`. Unique across the catalog. */
  name: string;
  domain: IntentDomainKey;
  /** Human-facing action title. */
  title: string;
  description: string;
  /** Parameter schema. */
  parameters: JSONSchema;
  privacy: IntentPrivacy;
  /** Entity types this intent reads. */
  consumes?: CiEntityType[];
  /** Entity types this intent returns. */
  produces?: CiEntityType[];
  /** Natural-language triggers (suggested phrasings). */
  phrases?: string[];
  binding: IntentBinding;
}

/** A catalog intent flattened for publication (binding replaced by its tool name). */
export interface ManifestIntent {
  name: string;
  tool: string;
  domain: IntentDomainKey;
  title: string;
  description: string;
  parameters: JSONSchema;
  privacy: IntentPrivacy;
  consumes: CiEntityType[];
  produces: CiEntityType[];
  phrases: string[];
}

/**
 * The discoverable capability declaration — a pre-declared, typed catalog of the
 * available intents. Served at `GET /api/intents` and as an MCP resource so every
 * harness reads one typed catalog.
 */
export interface IntentManifest {
  version: string;
  generatedAt: string;
  domains: IntentDomain[];
  entities: CiEntityDescriptor[];
  intents: ManifestIntent[];
}

/**
 * Derive the executable tool name from a dotted intent id. Dots are not allowed
 * in OpenAI/MCP tool names, so `memory.recall` → `memory_recall`.
 */
export function intentToolName(intentName: string): string {
  return intentName.replace(/\./g, '_');
}
