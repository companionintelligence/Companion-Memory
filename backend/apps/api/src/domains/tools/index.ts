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
import { TypeOrmModule } from '@nestjs/typeorm';

import { LoggerService } from '@ci/common/logging';
import { BlueBubblesModule } from '@ci/domains/bluebubbles';
import { ConversationModule } from '@ci/domains/conversations';
import { DailyMetricsModule } from '@ci/domains/daily-metrics';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { ImportModule } from '@ci/domains/import';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { ParsingModule } from '@ci/domains/parsing';
import { PredictionsModule } from '@ci/domains/predictions';
import { SearchNextModule } from '@ci/domains/search-next';
import { SummariesModule } from '@ci/domains/summaries';
import { UserModule } from '@ci/domains/user';

import { IntentCatalogService } from './catalog/IntentCatalogService';
import { ToolInvocationsController } from './controllers/ToolInvocationsController';
import { ToolInvocationRetentionCron } from './cron/ToolInvocationRetentionCron';
import { ToolInvocationEntity } from './entities/ToolInvocationEntity';
import { ToolInvokedListener } from './listeners/ToolInvokedListener';
import { NativeToolProvider } from './providers/NativeToolProvider';
import { ToolRegistry } from './registry/ToolRegistry';
import { ToolInvocationLedgerService } from './services/ToolInvocationLedgerService';
import { ToolsRegistrationService } from './services/ToolsRegistrationService';
import { AnomaliesRecentTool } from './tools/AnomaliesRecentTool';
import { BriefListTool } from './tools/BriefListTool';
import { CalendarFindEventsTool } from './tools/CalendarFindEventsTool';
import { DatabaseSearchTool } from './tools/DatabaseSearchTool';
import { ForecastCalibrationTool } from './tools/ForecastCalibrationTool';
import { ForecastReadTool } from './tools/ForecastReadTool';
import { ForgetKnowledgeTool } from './tools/ForgetKnowledgeTool';
import { GetEntertainmentPreferencesTool } from './tools/GetEntertainmentPreferencesTool';
import { GetFamilyMembersTool } from './tools/GetFamilyMembersTool';
import { GetStreamingAvailabilityTool } from './tools/GetStreamingAvailabilityTool';
import { GetUserPreferencesTool } from './tools/GetUserPreferencesTool';
import { ImportInboxTool } from './tools/ImportInboxTool';
import { ImportListSourcesTool } from './tools/ImportListSourcesTool';
import { ImportPathTool } from './tools/ImportPathTool';
import { ImportRecognizePathTool } from './tools/ImportRecognizePathTool';
import { ImportRunStatusTool } from './tools/ImportRunStatusTool';
import { ImportScanInboxTool } from './tools/ImportScanInboxTool';
import { InsightsExplainTool } from './tools/InsightsExplainTool';
import { MediaFindPhotosTool } from './tools/MediaFindPhotosTool';
import { MessagingListChatsTool } from './tools/MessagingListChatsTool';
import { MessagingListMessagesTool } from './tools/MessagingListMessagesTool';
import { MessagingSendTool } from './tools/MessagingSendTool';
import { PeopleFindTool } from './tools/PeopleFindTool';
import { PlacesFindTool } from './tools/PlacesFindTool';
import { PlacesNextTool } from './tools/PlacesNextTool';
import { ReadKnowledgeTool } from './tools/ReadKnowledgeTool';
import { SuggestionsFeedbackTool } from './tools/SuggestionsFeedbackTool';
import { SuggestionsListTool } from './tools/SuggestionsListTool';
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
  PlacesNextTool,
  CalendarFindEventsTool,
  MediaFindPhotosTool,
  ForecastCalibrationTool,
  ForecastReadTool,
  BriefListTool,
  InsightsExplainTool,
  AnomaliesRecentTool,
  SuggestionsListTool,
  SuggestionsFeedbackTool,
  // The import domain's intents. They live in that domain because they are
  // thin wrappers over its services; they are REGISTERED here because this is
  // where the native provider is assembled.
  ImportListSourcesTool,
  ImportRecognizePathTool,
  ImportPathTool,
  ImportRunStatusTool,
  ImportScanInboxTool,
  ImportInboxTool,
  // The messaging domain's intents — thin wrappers over BlueBubblesClientService
  // (domains/bluebubbles), following the same "declared here, implemented in its
  // own domain" pattern as the import intents above.
  MessagingSendTool,
  MessagingListChatsTool,
  MessagingListMessagesTool,
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
    ImportModule,
    PredictionsModule,
    SummariesModule,
    DailyMetricsModule,
    UserModule,
    // For MessagingSendTool/MessagingListChatsTool/MessagingListMessagesTool's
    // BlueBubblesClientService dependency.
    BlueBubblesModule,
    // ci.tool_invocations — the bounded invocation ledger the tool.invoked listener writes.
    TypeOrmModule.forFeature([ToolInvocationEntity]),
  ],
  controllers: [
    // The ledger's reader. Without it ci.tool_invocations would be another write-only table.
    ToolInvocationsController,
  ],
  providers: [
    ToolRegistry,
    // Consumes the durable tool.invoked signal (and registers its telemetry queue), appending it
    // to ci.tool_invocations.
    ToolInvokedListener,
    ToolInvocationLedgerService,
    // The 365-day bound. Ships with the table, not after it — see the cron's own note on api_logs.
    ToolInvocationRetentionCron,
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
export { ToolRegistry, outcomeOf } from './registry/ToolRegistry';
export { IntentCatalogService } from './catalog/IntentCatalogService';
export type { IntentManifest, ManifestIntent, IntentDomain, CiEntityDescriptor } from './catalog/types';
export { BaseTool } from './core/BaseTool';
export { ToolInvokedEvent, TOOL_INVOCATION_OUTCOMES, TOOL_INVOCATION_ERROR_MAX_LENGTH } from './events';
export type { ToolInvokedPayload, ToolInvocationOutcome } from './events';
export { ToolInvocationEntity } from './entities/ToolInvocationEntity';
export {
  ToolInvocationLedgerService,
  TOOL_INVOCATION_RETENTION_DAYS,
} from './services/ToolInvocationLedgerService';
export type { ToolInvocationQuery } from './services/ToolInvocationLedgerService';
export type { ToolProvider, ProviderHealthStatus } from './providers/ToolProvider';
export {
  intentToolName,
  canonicalizeExecutableToolName,
  type JSONSchema,
  type ToolSchema,
  type ToolResult,
  type ToolExecutionContext,
  type ToolInvocationContext,
  type ToolError,
  type IntentDefinition,
  type IntentDomainKey,
  type IntentAccess,
  type IntentSensitivity,
  type IntentPrivacy,
  type CiEntityType,
} from './core/types';
// Execution policy — one implementation of "may this caller run this intent, here?", shared by
// every dispatcher (MCP, the in-house chat model, and the on-device tier via the manifest).
export {
  DISPATCH_TIERS,
  capabilityAllows,
  capabilityRequiredFor,
  removesData,
  resolveDispatch,
  type DispatchDecision,
  type DispatchOptions,
  type DispatchReason,
  type DispatchRuling,
  type DispatchTier,
  type DispatchableIntent,
  type GatedPrivacy,
} from './policy';
