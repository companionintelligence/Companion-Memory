import { Module } from '@nestjs/common';

import { EventsModule } from '@ci/domains/events';
import { LLMModule } from '@ci/domains/llm';

import { McpController } from './controllers/McpController';
import { McpHealthController } from './controllers/McpHealthController';
import { McpHostService } from './services/McpHostService';

@Module({
  imports: [EventsModule, LLMModule],
  providers: [McpHostService],
  controllers: [McpController, McpHealthController],
  exports: [McpHostService],
})
export class McpModule {}

// Services
export { McpHostService };

// Types
export type {
  McpServerConfig,
  McpServersConfig,
  McpSession,
  McpToolResult,
  McpHealthStatus,
} from './types/mcp-config';
