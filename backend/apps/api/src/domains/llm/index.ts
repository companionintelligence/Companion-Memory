import { Module, forwardRef } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { McpModule } from '@ci/domains/mcp';

import { OllamaController } from './controllers/OllamaController';
import { OllamaService } from './services/OllamaService';
import { ToolRegistry } from './tools/ToolRegistry';

@Module({
  imports: [ConversationModule, EventsModule, FilesModule, forwardRef(() => McpModule)],
  providers: [OllamaService, ToolRegistry],
  controllers: [OllamaController],
  exports: [OllamaService, ToolRegistry],
})
export class LLMModule {}

// Entities
export {};

// Services
export { OllamaService };

// Types
export type {} from './types';
