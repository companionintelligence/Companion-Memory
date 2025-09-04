import { Module } from '@nestjs/common';

import { EventsModule } from '@ci/domains/events';
import { LLMModule } from '@ci/domains/llm';

import { McpController } from './controllers/McpController';
import { McpHostService } from './services/McpHostService';

@Module({
  imports: [EventsModule, LLMModule],
  providers: [McpHostService],
  controllers: [McpController],
  exports: [McpHostService],
})
export class McpModule {}

// Services
export { McpHostService };

// Types
export type { McpServerConfig, McpServersConfig, McpSession, McpToolResult } from './types/mcp-config';
