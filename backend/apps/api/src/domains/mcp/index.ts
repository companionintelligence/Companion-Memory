import { Module } from '@nestjs/common';

import { GraphQLModule } from '@ci/domains/graphql';

import { McpController } from './controllers/McpController';
import { McpExecutorService } from './services/McpExecutorService';
import { McpSchemaService } from './services/McpSchemaService';
import { McpServerService } from './services/McpServerService';

@Module({
  imports: [GraphQLModule],
  controllers: [McpController],
  providers: [McpSchemaService, McpExecutorService, McpServerService],
  exports: [McpServerService],
})
export class McpModule {}
