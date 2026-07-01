import { Controller, Get, Param, NotFoundException, UseGuards } from '@nestjs/common';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import {
  IntentCatalogService,
  type CiEntityDescriptor,
  type IntentDomain,
  type IntentManifest,
  type ManifestIntent,
} from '@ci/domains/tools';

/**
 * Publishes the CI Intent catalog — the discoverable, typed capability declaration. Any agent
 * (CI-Hermes, CI-OpenClaw, an external MCP client) can read one catalog here instead of
 * re-implementing bespoke integration glue.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Controller('api/intents')
export class IntentsController {
  constructor(private readonly catalog: IntentCatalogService) {}

  /** The full manifest: domains + entities + intents. */
  @Get()
  getManifest(): IntentManifest {
    return this.catalog.getManifest();
  }

  /** The standardized schema-domain vocabulary. */
  @Get('domains')
  getDomains(): { domains: IntentDomain[] } {
    return { domains: this.catalog.getDomains() };
  }

  /** The entity registry. */
  @Get('entities')
  getEntities(): { entities: CiEntityDescriptor[] } {
    return { entities: this.catalog.getEntities() };
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
