/**
 * The published CI Intent catalog shape — the discoverable, typed capability declaration.
 *
 * The per-tool metadata types (domain key, privacy, entity type, the intent definition itself)
 * live in the tools domain because each intent IS a tool. These types describe how that catalog
 * is *published* (REST + the MCP `intents://catalog` resource), so they live with the catalog
 * here in the agent domain.
 */

import type { CiEntityType, IntentDomainKey, IntentPrivacy, JSONSchema } from '@ci/domains/tools';

/**
 * Display descriptor for a schema domain. The standardized verb vocabulary intents are grouped
 * under, so agents and apps speak the same language.
 */
export interface IntentDomain {
  key: IntentDomainKey;
  title: string;
  description: string;
}

/**
 * Display + identity descriptor for an entity type. Published in the manifest so agents can
 * render and resolve entities uniformly.
 */
export interface CiEntityDescriptor {
  type: CiEntityType;
  title: string;
  description: string;
  idKind: 'uuid' | 'global-uid';
}

/** A catalog intent flattened for publication (binding replaced by its executable tool name). */
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
 * The discoverable capability declaration — a pre-declared, typed catalog of the available
 * intents. Served at `GET /api/intents` and as an MCP resource so every harness reads one typed
 * catalog.
 */
export interface IntentManifest {
  version: string;
  generatedAt: string;
  domains: IntentDomain[];
  entities: CiEntityDescriptor[];
  intents: ManifestIntent[];
}
