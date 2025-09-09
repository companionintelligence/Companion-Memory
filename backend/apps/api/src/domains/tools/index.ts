import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';

import { ToolsController } from './controllers/ToolsController';
import { McpClientManager } from './providers/mcp/McpClientManager';
import { McpToolProvider } from './providers/mcp/McpToolProvider';
import { GetEntertainmentPreferencesTool } from './providers/native/GetEntertainmentPreferencesTool';
import { GetFamilyMembersTool } from './providers/native/GetFamilyMembersTool';
import { GetStreamingAvailabilityTool } from './providers/native/GetStreamingAvailabilityTool';
import { GetUserPreferencesTool } from './providers/native/GetUserPreferencesTool';
import { NativeToolProvider } from './providers/native/NativeToolProvider';
import { ToolRegistry } from './registry/ToolRegistry';
import { ToolsRegistrationService } from './services/ToolsRegistrationService';

// Instantiate native tools
const nativeToolInstances = [
  GetUserPreferencesTool,
  GetEntertainmentPreferencesTool,
  GetFamilyMembersTool,
  GetStreamingAvailabilityTool,
];

@Module({
  imports: [EventsModule, ConversationModule, FilesModule],
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
  controllers: [ToolsController],
  exports: [ToolRegistry],
})
export class ToolsModule {}

// Exports
export { ToolRegistry };
export type { ToolSchema, ToolResult, ToolExecutionContext, ToolError } from './core/types';
export type { ProviderHealthStatus } from './providers/ToolProvider';
