import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { MemoryModule } from '@ci/domains/memory';
import { ToolsModule } from '@ci/domains/tools';

import { OllamaController } from './controllers/OllamaController';
import { OllamaService } from './services/OllamaService';

@Module({
  imports: [ConversationModule, EventsModule, FilesModule, MemoryModule, ToolsModule],
  providers: [OllamaService],
  controllers: [OllamaController],
  exports: [OllamaService],
})
export class LLMModule {}

// Services
export { OllamaService };

// Types
export type {} from './types';
