import { Module } from '@nestjs/common';

import { GraphQLModule } from '@ci/domains/graphql';
import { LlmCoreModule } from '@ci/domains/llm';
import { ToolsModule } from '@ci/domains/tools';

import { McpController } from './controllers/McpController';
import { ProtectedResourceMetadataController } from './controllers/ProtectedResourceMetadataController';
import { GraphQLToolAdapter } from './services/GraphQLToolAdapter';
import { McpExecutorService } from './services/McpExecutorService';
import { McpServerService } from './services/McpServerService';
import { McpToolService } from './services/McpToolService';

// ToolsModule registers every tool (each a curated intent) into the shared ToolRegistry BEFORE
// McpToolService consolidates it (Nest initialises imported modules first), making them
// discoverable as MCP tools. It also provides IntentCatalogService, which backs the
// `intents://catalog` MCP resource.
// LlmCoreModule for DesktopAppService: a failed tool call says when Memory Desktop is closed.
@Module({
  imports: [GraphQLModule, ToolsModule, LlmCoreModule],
  controllers: [McpController, ProtectedResourceMetadataController],
  providers: [GraphQLToolAdapter, McpExecutorService, McpToolService, McpServerService],
  exports: [McpServerService],
})
export class McpModule {}
