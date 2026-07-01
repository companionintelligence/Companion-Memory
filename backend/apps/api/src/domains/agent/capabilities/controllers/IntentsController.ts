import { Controller, Get, Param, NotFoundException, UseGuards } from '@nestjs/common';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { IntentCatalogService } from '../services/IntentCatalogService';
import { IntentRegistry } from '../services/IntentRegistry';
import type { CiEntityDescriptor, IntentDomain, IntentManifest, ManifestIntent } from '../types';

/**
 * Publishes the CI Intent catalog — the discoverable, typed capability
 * declaration. Any agent (CI-Hermes, CI-OpenClaw, an external MCP client) can read
 * one catalog here instead of re-implementing bespoke integration glue.
 *
 * Canonical path is `/api/agent/intents` (the catalog lives in the agent
 * capability domain). `/api/intents` stays mounted as a deprecated alias so
 * existing harness clients keep working during migration.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Controller(['api/agent/intents', 'api/intents'])
export class IntentsController {
  constructor(
    private readonly catalog: IntentCatalogService,
    private readonly registry: IntentRegistry,
  ) {}

  /** The full manifest: domains + entities + intents. */
  @Get()
  getManifest(): IntentManifest {
    return this.catalog.getManifest();
  }

  /** The standardized schema-domain vocabulary. */
  @Get('domains')
  getDomains(): { domains: IntentDomain[] } {
    return { domains: this.registry.getDomains() };
  }

  /** The entity registry. */
  @Get('entities')
  getEntities(): { entities: CiEntityDescriptor[] } {
    return { entities: this.registry.getEntities() };
  }

  /** A single intent by its dotted name, e.g. `memory.recall`. */
  @Get(':name')
  getIntent(@Param('name') name: string): ManifestIntent {
    const manifest = this.catalog.getManifest();
    const intent = manifest.intents.find((i) => i.name === name);

    if (!intent) {
      throw new NotFoundException(`Unknown intent: ${name}`);
    }

    return intent;
  }
}
