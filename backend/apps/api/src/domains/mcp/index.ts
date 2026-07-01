import { Module } from '@nestjs/common';

import { AgentModule } from '@ci/domains/agent';
import { GraphQLModule } from '@ci/domains/graphql';
import { ToolsModule } from '@ci/domains/tools';

import { McpController } from './controllers/McpController';
import { GraphQLToolAdapter } from './services/GraphQLToolAdapter';
import { McpExecutorService } from './services/McpExecutorService';
import { McpServerService } from './services/McpServerService';
import { McpToolService } from './services/McpToolService';

// ToolsModule registers the curated intent shells into the shared ToolRegistry BEFORE
// McpToolService consolidates it (Nest initialises imported modules first), making intents
// discoverable as MCP tools. AgentModule provides the IntentCatalogService that backs the
// `intents://catalog` MCP resource.
@Module({
  imports: [GraphQLModule, AgentModule, ToolsModule],
  controllers: [McpController],
  providers: [GraphQLToolAdapter, McpExecutorService, McpToolService, McpServerService],
  exports: [McpServerService],
})
export class McpModule {}
