import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { FileEntity } from '@ci/domains/files/entities/FileEntity';

import { OllamaController } from './controllers/OllamaController';
import { OllamaService } from './services/OllamaService';

@Module({
  imports: [
    ConversationModule, 
    EventsModule, 
    FilesModule,
    TypeOrmModule.forFeature([FileEntity])
  ],
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
