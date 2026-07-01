/**
 * This module provides a framework for defining, registering, and executing "tools" that the
 * Large Language Model (LLM) can use to perform actions and retrieve information. It establishes
 * a pluggable architecture that allows for different tool providers, such as native, in-application
 * functions and external services.
 *
 * ### Key Components:
 * - **`ToolRegistry`**: A central service that holds a collection of all available tools from
 *   all registered providers. It serves as the single point of entry for the LLM to discover
 *   and execute tools.
 * - **Tool Providers (`NativeToolProvider`)**: These are responsible for
 *   supplying a set of tools from a specific source. The `NativeToolProvider` manages tools
 *   defined directly within the application, while other providers can interface with external
 *   systems.
 * - **Individual Tools (`GetUserPreferencesTool`, etc.)**: These are the concrete implementations
 *   of actions the LLM can invoke, each with a defined schema for its inputs and outputs.
 *
 * Each provider self-registers with the `ToolRegistry` in its own `onModuleInit`,
 * so adding a capability source is just adding a provider — no central
 * registration service to keep in sync.
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
import { SearchNextModule } from '@ci/domains/search-next';

import { DatabaseSearchTool } from './providers/native/DatabaseSearchTool';
import { ForgetKnowledgeTool } from './providers/native/ForgetKnowledgeTool';
import { GetEntertainmentPreferencesTool } from './providers/native/GetEntertainmentPreferencesTool';
import { GetFamilyMembersTool } from './providers/native/GetFamilyMembersTool';
import { GetStreamingAvailabilityTool } from './providers/native/GetStreamingAvailabilityTool';
import { GetUserPreferencesTool } from './providers/native/GetUserPreferencesTool';
import { NativeToolProvider } from './providers/native/NativeToolProvider';
import { ReadKnowledgeTool } from './providers/native/ReadKnowledgeTool';
import { WriteKnowledgeTool } from './providers/native/WriteKnowledgeTool';
import { ToolRegistry } from './registry/ToolRegistry';

// Instantiate native tools
const nativeToolInstances = [
  ReadKnowledgeTool,
  WriteKnowledgeTool,
  ForgetKnowledgeTool,
  GetUserPreferencesTool,
  GetFamilyMembersTool,
  GetEntertainmentPreferencesTool,
  GetStreamingAvailabilityTool,
  DatabaseSearchTool,
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
    SearchNextModule,
  ],
  providers: [
    ToolRegistry,
    // Native tools
    ...nativeToolInstances,
    // Native tool provider with injected tools. Self-registers with the
    // ToolRegistry in its onModuleInit — no separate registration service.
    {
      provide: NativeToolProvider,
      inject: [LoggerService, ToolRegistry, ...nativeToolInstances],
      useFactory: (...args) => {
        const [logger, toolRegistry, ...tools] = args;

        return new NativeToolProvider(tools, logger, toolRegistry);
      },
    },
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}

// Exports
export { ToolRegistry };
export { BaseTool } from './core/BaseTool';
export type { JSONSchema, ToolSchema, ToolResult, ToolExecutionContext, ToolError } from './core/types';
export type { ToolProvider, ProviderHealthStatus } from './providers/ToolProvider';
