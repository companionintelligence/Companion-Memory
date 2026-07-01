import { Injectable, type OnModuleInit } from '@nestjs/common';

import { ToolRegistry, intentToolName } from '@ci/domains/tools';

import { INTENT_DOMAINS, isIntentDomain } from '../catalog/domains';
import { CI_ENTITIES } from '../catalog/entities';
import type { CiEntityDescriptor, IntentDomain, IntentManifest, ManifestIntent } from '../catalog/types';

const MANIFEST_VERSION = '1.0.0';

/**
 * Public read API over the intent catalog — the single seam through which REST, the MCP resource,
 * and CI-Hub app registration read the manifest. Every tool is an intent, so the catalog is built
 * directly from the {@link ToolRegistry}: each registered tool's schema is an IntentDefinition,
 * overlaid here with the domain + entity vocabulary that lives in the agent domain.
 *
 * At boot it validates that every tool references a registered schema domain (fail-fast). This
 * check lives here, not in the tools domain, because the domain vocabulary lives here.
 */
@Injectable()
export class IntentCatalogService implements OnModuleInit {
  constructor(private readonly tools: ToolRegistry) {}

  onModuleInit(): void {
    for (const schema of this.tools.getAvailableTools()) {
      if (!isIntentDomain(schema.domain)) {
        throw new Error(`Tool ${schema.name} references unknown domain "${schema.domain}"`);
      }
    }
  }

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
