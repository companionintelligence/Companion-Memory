import { Module } from '@nestjs/common';

import { AuthScopesModule } from '@ci/common/scopes';
import { GraphQLModule } from '@ci/domains/graphql';
import { ToolsModule } from '@ci/domains/tools';

import { McpController } from './controllers/McpController';
import { GraphQLToolAdapter } from './services/GraphQLToolAdapter';
import { McpExecutorService } from './services/McpExecutorService';
import { McpServerService } from './services/McpServerService';
import { McpToolService } from './services/McpToolService';

@Module({
  imports: [GraphQLModule, ToolsModule, AuthScopesModule],
  controllers: [McpController],
  providers: [GraphQLToolAdapter, McpExecutorService, McpToolService, McpServerService],
  exports: [McpServerService],
})
export class McpModule {}
