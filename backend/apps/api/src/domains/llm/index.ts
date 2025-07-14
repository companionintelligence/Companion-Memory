import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { OllamaController } from './controllers/OllamaController';
import { MediaAnalysisController } from './controllers/MediaAnalysisController';
import { ThreadsController } from './controllers/ThreadsController';
import { MessageEntity } from './entities/MessageEntity';
import { ThreadEntity } from './entities/ThreadEntity';
import { MessageService } from './services/MessageService';
import { OllamaService } from './services/OllamaService';
import { MediaAnalysisService } from './services/MediaAnalysisService';
import { ThreadService } from './services/ThreadService';

@Module({
  imports: [TypeOrmModule.forFeature([MessageEntity, ThreadEntity]), EventsModule],
  providers: [MessageService, OllamaService, MediaAnalysisService, ThreadService],
  controllers: [OllamaController, MediaAnalysisController, ThreadsController],
  exports: [],
})
export class LLMModule {}

// Entities
export { MessageEntity, ThreadEntity };

// Services
export { MediaAnalysisService };

// Types
export type { MediaAnalysisInput, MediaAnalysisResult, MediaEntity } from './types';
