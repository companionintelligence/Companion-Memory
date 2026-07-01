import { Module } from '@nestjs/common';

import { IntentsModule } from '@ci/domains/agent-capabilities';
import { GraphQLModule } from '@ci/domains/graphql';
import { ToolsModule } from '@ci/domains/tools';

import { McpController } from './controllers/McpController';
import { GraphQLToolAdapter } from './services/GraphQLToolAdapter';
import { McpExecutorService } from './services/McpExecutorService';
import { McpServerService } from './services/McpServerService';
import { McpToolService } from './services/McpToolService';

// IntentsModule is imported so the curated intent catalog registers into the
// shared ToolRegistry BEFORE McpToolService consolidates it (Nest initialises
// imported modules first), making intents discoverable as MCP tools.
@Module({
  imports: [GraphQLModule, IntentsModule, ToolsModule],
  controllers: [McpController],
  providers: [GraphQLToolAdapter, McpExecutorService, McpToolService, McpServerService],
  exports: [McpServerService],
})
export class McpModule {}
