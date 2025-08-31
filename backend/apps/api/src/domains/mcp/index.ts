import { Module } from '@nestjs/common';

import { EventsModule } from '@ci/domains/events';
import { LLMModule } from '@ci/domains/llm';

import { McpController } from './controllers/McpController';
import { McpService } from './services/McpService';

@Module({
  imports: [EventsModule, LLMModule],
  providers: [McpService],
  controllers: [McpController],
  exports: [McpService],
})
export class McpModule {}

// Services
export { McpService };

// Types
export type { McpTool, McpToolCall, McpToolResult, McpCallRequest, McpCallResponse } from './types';
