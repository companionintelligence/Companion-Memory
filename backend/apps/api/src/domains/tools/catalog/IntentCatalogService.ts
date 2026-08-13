import { Injectable } from '@nestjs/common';

import { intentToolName } from '../core/types';
import { ToolRegistry } from '../registry/ToolRegistry';

import { INTENT_DOMAINS } from './domains';
import { CI_ENTITIES } from './entities';
import type { CiEntityDescriptor, IntentDomain, IntentManifest, ManifestIntent } from './types';

// 1.1.0 — added `localCapable` per intent. Additive, so a 1.0.0 client keeps working; a client
// that wants to decide anything offline needs the field, hence the minor bump rather than silence.
const MANIFEST_VERSION = '1.1.0';

/**
 * Public read API over the intent catalog — the single seam through which REST (the agent-domain
 * IntentsController), the MCP `intents://catalog` resource, and CI-Hub app registration read the
 * manifest. Every tool is an intent, so the catalog is built directly from the {@link ToolRegistry}
 * (each registered tool's schema is an IntentDefinition), overlaid with the domain + entity
 * vocabulary. Boot-time validation that each tool's domain is registered lives in
 * ToolsRegistrationService, right after the tools are loaded.
 */
@Injectable()
export class IntentCatalogService {
  constructor(private readonly tools: ToolRegistry) {}

  /** The full discoverable capability declaration. */
  getManifest(): IntentManifest {
    const intents: ManifestIntent[] = this.tools.getAvailableTools().map((schema) => ({
      name: schema.name,
      tool: intentToolName(schema.name),
      domain: schema.domain,
      title: schema.title,
      description: schema.description,
      parameters: schema.parameters,
      privacy: schema.privacy,
      // No `?? false` fallback: the field is required on IntentDefinition precisely so the
      // manifest never has to guess, and a silent `false` here would publish "not available
      // offline" for an intent whose author simply forgot to label it.
      localCapable: schema.localCapable,
      consumes: schema.consumes ?? [],
      produces: schema.produces ?? [],
      phrases: schema.phrases ?? [],
    }));

    intents.sort((a, b) => a.name.localeCompare(b.name));

    return {
      version: MANIFEST_VERSION,
      generatedAt: new Date().toISOString(),
      domains: this.getDomains(),
      entities: this.getEntities(),
      intents,
    };
  }

  getDomains(): IntentDomain[] {
    return [...INTENT_DOMAINS];
  }

  getEntities(): CiEntityDescriptor[] {
    return [...CI_ENTITIES];
  }
}
