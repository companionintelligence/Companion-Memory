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
 * - **Tool Providers (`NativeToolProvider`, `McpToolProvider`)**: These are responsible for
 *   supplying a set of tools from a specific source. The `NativeToolProvider` manages tools
 *   defined directly within the application, while other providers can interface with external
 *   systems.
 * - **Individual Tools (`GetUserPreferencesTool`, etc.)**: These are the concrete implementations
 *   of actions the LLM can invoke, each with a defined schema for its inputs and outputs.
 * - **`ToolsRegistrationService`**: An initialization service that runs when the module loads,
 *   registering all available tool providers with the central `ToolRegistry`.
 *
 * @module ToolsModule
 */

import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { MemoryModule } from '@ci/domains/memory';

import { McpController } from './controllers/McpController';
import { McpClientManager } from './providers/mcp/McpClientManager';
import { McpToolProvider } from './providers/mcp/McpToolProvider';
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
import { McpToolsService } from './services/McpToolsService';
import { ToolsRegistrationService } from './services/ToolsRegistrationService';

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
  imports: [EventsModule, ConversationModule, FilesModule, MemoryModule],
  controllers: [McpController],
  providers: [
    ToolRegistry,
    McpClientManager,
    McpToolProvider,
    // Native tools
    ...nativeToolInstances,
    // Native tool provider with injected tools
    {
      provide: NativeToolProvider,
      useFactory: (...tools) => new NativeToolProvider(tools),
      inject: nativeToolInstances,
    },
    // Registration service to wire everything together
    ToolsRegistrationService,
    McpToolsService,
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}

// Exports
export { ToolRegistry };
export type { ToolSchema, ToolResult, ToolExecutionContext, ToolError } from './core/types';
export type { ProviderHealthStatus } from './providers/ToolProvider';
