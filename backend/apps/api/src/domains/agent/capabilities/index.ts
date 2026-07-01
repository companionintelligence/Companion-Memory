/**
 * CI Intent Catalog — the semantic capability layer.
 *
 * Provides a curated, typed, domain-organized, privacy-labelled catalog of
 * actions ({@link IntentDefinition}) over capabilities that already exist in
 * CI-Server. The catalog is:
 *  - registered into the shared `ToolRegistry` (via {@link IntentToolProvider}),
 *    so intents flow to the local LLM and the MCP server automatically;
 *  - published as a manifest at `GET /api/agent/intents` (with `/api/intents`
 *    kept as a deprecated alias) so CI-Hermes, CI-OpenClaw, and external MCP
 *    clients discover one typed vocabulary instead of bespoke per-harness glue.
 *
 * @module IntentsModule
 */

import { Module } from '@nestjs/common';

import { ToolsModule } from '@ci/domains/tools';

import { IntentsController } from './controllers/IntentsController';
import { IntentCatalogService } from './services/IntentCatalogService';
import { IntentDonationService } from './services/IntentDonationService';
import { IntentRegistry } from './services/IntentRegistry';
import { IntentToolProvider } from './services/IntentToolProvider';

@Module({
  imports: [ToolsModule],
  providers: [
    IntentRegistry,
    IntentCatalogService,
    IntentDonationService,
    // Self-registers with the ToolRegistry in its onModuleInit.
    IntentToolProvider,
  ],
  controllers: [IntentsController],
  exports: [IntentRegistry, IntentCatalogService],
})
export class IntentsModule {}

export { IntentRegistry } from './services/IntentRegistry';
export { IntentCatalogService } from './services/IntentCatalogService';
export {
  type IntentDefinition,
  type IntentDomain,
  type IntentManifest,
  type ManifestIntent,
  type CiEntityDescriptor,
  type IntentPrivacy,
  intentToolName,
} from './types';
