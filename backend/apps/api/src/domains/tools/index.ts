/**
 * This module provides a framework for defining, registering, and executing "tools" that the
 * Large Language Model (LLM) can use to perform actions and retrieve information.
 *
 * Every tool IS an intent: each tool class declares its curated {@link IntentDefinition} schema
 * (dotted name, domain, privacy label, NL phrases, parameters) inline next to its implementation.
 * There is no separate intent catalog or wrapper — definition and behaviour live together.
 *
 * ### Key Components:
 * - **`ToolRegistry`**: central service holding all tools from all providers; the single entry
 *   point for the LLM/MCP to discover and execute tools. Keys tools by their executable name
 *   (dots→underscores) and donates every invocation as a behavioral signal.
 * - **`NativeToolProvider`**: supplies the in-application tools.
 * - **Individual tools** (`ReadKnowledgeTool`, `PeopleFindTool`, …): concrete implementations,
 *   each carrying its own IntentDefinition. Domain-scoped search intents (`PeopleFindTool`, …)
 *   delegate to `DatabaseSearchTool` with a fixed entity scope.
 * - **`ToolsRegistrationService`**: registers the provider with the registry at boot.
 *
 * @module ToolsModule
 */

import { Module } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { ParsingModule } from '@ci/domains/parsing';
import { SearchNextModule } from '@ci/domains/search-next';

import { IntentCatalogService } from './catalog/IntentCatalogService';
import { ToolInvokedListener } from './listeners/ToolInvokedListener';
import { NativeToolProvider } from './providers/NativeToolProvider';
import { ToolRegistry } from './registry/ToolRegistry';
import { ToolsRegistrationService } from './services/ToolsRegistrationService';
import { CalendarFindEventsTool } from './tools/CalendarFindEventsTool';
import { DatabaseSearchTool } from './tools/DatabaseSearchTool';
import { ForgetKnowledgeTool } from './tools/ForgetKnowledgeTool';
import { GetEntertainmentPreferencesTool } from './tools/GetEntertainmentPreferencesTool';
import { GetFamilyMembersTool } from './tools/GetFamilyMembersTool';
import { GetStreamingAvailabilityTool } from './tools/GetStreamingAvailabilityTool';
import { GetUserPreferencesTool } from './tools/GetUserPreferencesTool';
import { MediaFindPhotosTool } from './tools/MediaFindPhotosTool';
import { PeopleFindTool } from './tools/PeopleFindTool';
import { PlacesFindTool } from './tools/PlacesFindTool';
import { ReadKnowledgeTool } from './tools/ReadKnowledgeTool';
import { WriteKnowledgeTool } from './tools/WriteKnowledgeTool';

// Instantiate native tools. Each is a curated intent (its schema is an IntentDefinition);
// DatabaseSearchTool backs the four domain-scoped search intents below it.
const nativeToolInstances = [
  ReadKnowledgeTool,
  WriteKnowledgeTool,
  ForgetKnowledgeTool,
  GetUserPreferencesTool,
  GetFamilyMembersTool,
  GetEntertainmentPreferencesTool,
  GetStreamingAvailabilityTool,
  DatabaseSearchTool,
  PeopleFindTool,
  PlacesFindTool,
  CalendarFindEventsTool,
  MediaFindPhotosTool,
];

/**
 * @internal
 */
@Module({
  imports: [
    EventsModule,
    ConversationModule,
    FilesModule,
    MemoryModule,
    IntelligenceModule,
    ParsingModule,
    SearchNextModule,
  ],
  providers: [
    ToolRegistry,
    // Consumes the durable tool.invoked signal (and registers its telemetry queue).
    ToolInvokedListener,
    // Native tools (each a curated intent)
    ...nativeToolInstances,
    // Native tool provider with injected tools
    {
      provide: NativeToolProvider,
      inject: [LoggerService, ...nativeToolInstances],
      useFactory: (...args) => {
        const [logger, ...tools] = args;

        return new NativeToolProvider(tools, logger);
      },
    },
    // Registration service to wire everything together
    ToolsRegistrationService,
    // Read API over the tool catalog (manifest), consumed by the agent REST controller + MCP.
    IntentCatalogService,
  ],
  exports: [ToolRegistry, IntentCatalogService],
})
export class ToolsModule {}

// Exports
export { ToolRegistry };
export { IntentCatalogService } from './catalog/IntentCatalogService';
export type { IntentManifest, ManifestIntent, IntentDomain, CiEntityDescriptor } from './catalog/types';
export { BaseTool } from './core/BaseTool';
export { ToolInvokedEvent } from './events';
export type { ToolInvokedPayload } from './events';
export type { ToolProvider, ProviderHealthStatus } from './providers/ToolProvider';
export {
  intentToolName,
  type JSONSchema,
  type ToolSchema,
  type ToolResult,
  type ToolExecutionContext,
  type ToolError,
  type IntentDefinition,
  type IntentDomainKey,
  type IntentAccess,
  type IntentSensitivity,
  type IntentPrivacy,
  type CiEntityType,
} from './core/types';
