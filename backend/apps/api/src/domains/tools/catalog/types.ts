/**
 * The published CI Intent catalog shape — the discoverable, typed capability declaration.
 *
 * Every tool is an intent, so the catalog is entirely tool metadata: it describes how the tools
 * registered in this domain are published (over REST via the agent-domain controller and over MCP
 * as the `intents://catalog` resource).
 */

import type { CiEntityType, IntentDomainKey, IntentPrivacy, JSONSchema } from '../core/types';

/**
 * Display descriptor for a schema domain — the standardized verb vocabulary tools are grouped
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

/** A tool flattened for publication: its dotted intent name plus its executable tool name. */
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
