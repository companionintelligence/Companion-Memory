import { Module } from '@nestjs/common';

import { AuthScopesModule } from '@ci/common/scopes';
import { GraphQLModule } from '@ci/domains/graphql';
import { MemoryModule } from '@ci/domains/memory';
import { ToolsModule } from '@ci/domains/tools';

import { McpController } from './controllers/McpController';
import { GraphQLToolAdapter } from './services/GraphQLToolAdapter';
import { McpExecutorService } from './services/McpExecutorService';
import { McpPromptService } from './services/McpPromptService';
import { McpResourceSubscriber } from './services/McpResourceSubscriber';
import { McpServerService } from './services/McpServerService';
import { McpToolService } from './services/McpToolService';

@Module({
  imports: [GraphQLModule, ToolsModule, AuthScopesModule, MemoryModule],
  controllers: [McpController],
  providers: [
    GraphQLToolAdapter,
    McpExecutorService,
    McpToolService,
    McpPromptService,
    McpResourceSubscriber,
    McpServerService,
  ],
  exports: [McpServerService],
})
export class McpModule {}
