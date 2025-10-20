import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { GraphModule } from '@ci/domains/graph';
import { MemoryModule } from '@ci/domains/memory';

import { McpClientManager } from './providers/mcp/McpClientManager';
import { McpToolProvider } from './providers/mcp/McpToolProvider';
import { ForgetKnowledgeTool } from './providers/native/ForgetKnowledgeTool';
import { GetEntertainmentPreferencesTool } from './providers/native/GetEntertainmentPreferencesTool';
import { GetFamilyMembersTool } from './providers/native/GetFamilyMembersTool';
import { GetStreamingAvailabilityTool } from './providers/native/GetStreamingAvailabilityTool';
import { GetUserPreferencesTool } from './providers/native/GetUserPreferencesTool';
import { NativeToolProvider } from './providers/native/NativeToolProvider';
import { ReadKnowledgeTool } from './providers/native/ReadKnowledgeTool';
import { WriteKnowledgeTool } from './providers/native/WriteKnowledgeTool';
import { ToolRegistry } from './registry/ToolRegistry';
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
];

@Module({
  imports: [EventsModule, ConversationModule, FilesModule, MemoryModule, GraphModule],
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
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}

// Exports
export { ToolRegistry };
export type { ToolSchema, ToolResult, ToolExecutionContext, ToolError } from './core/types';
export type { ProviderHealthStatus } from './providers/ToolProvider';
