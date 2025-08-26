import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';

import { OllamaController } from './controllers/OllamaController';
import { OllamaService } from './services/OllamaService';

@Module({
  imports: [ConversationModule, EventsModule],
  providers: [OllamaService],
  controllers: [OllamaController],
  exports: [OllamaService],
})
export class LLMModule {}

// Entities
export {};

// Services
export { OllamaService };

// Types
export type {} from './types';
