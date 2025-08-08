import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmbeddingController } from './controllers/EmbeddingController';
import { EmbeddingEntity } from './entities/EmbeddingEntity';
import { TagEntity } from './entities/TagEntity';
import { EmbeddingService } from './services/EmbeddingService';

@Module({
  imports: [TypeOrmModule.forFeature([EmbeddingEntity, TagEntity])],
  providers: [EmbeddingService],
  controllers: [EmbeddingController],
  exports: [EmbeddingService],
})
export class EmbeddingModule {}

// Entities
export { EmbeddingEntity, TagEntity };

// Services
export { EmbeddingService };

// Types
export type {} from './types';
