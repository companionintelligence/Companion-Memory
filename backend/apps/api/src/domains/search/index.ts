import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmbeddingController } from './controllers/EmbeddingController';
import { TagController } from './controllers/TagController';
import { EmbeddingEntity } from './entities/EmbeddingEntity';
import { TagEntity } from './entities/TagEntity';
import { EmbeddingService } from './services/EmbeddingService';
import { TagService } from './services/TagService';

@Module({
  imports: [TypeOrmModule.forFeature([EmbeddingEntity, TagEntity])],
  providers: [EmbeddingService, TagService],
  controllers: [EmbeddingController, TagController],
  exports: [EmbeddingService, TagService],
})
export class EmbeddingModule {}

// Entities
export { EmbeddingEntity, TagEntity };

// Services
export { EmbeddingService, TagService };

// Types
export type {} from './types';
