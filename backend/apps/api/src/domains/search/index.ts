import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmbeddingController } from './controllers/EmbeddingController';
import { SavedSearchController } from './controllers/SavedSearchController';
import { EmbeddingEntity } from './entities/EmbeddingEntity';
import { SavedSearchEntity } from './entities/SavedSearchEntity';
import { TagEntity } from './entities/TagEntity';
import { EmbeddingService } from './services/EmbeddingService';
import { SavedSearchService } from './services/SavedSearchService';

@Module({
  imports: [TypeOrmModule.forFeature([EmbeddingEntity, SavedSearchEntity, TagEntity])],
  providers: [EmbeddingService, SavedSearchService],
  controllers: [EmbeddingController, SavedSearchController],
  exports: [EmbeddingService, SavedSearchService],
})
export class EmbeddingModule {}

// Entities
export { EmbeddingEntity, SavedSearchEntity, TagEntity };

// Services
export { EmbeddingService, SavedSearchService };

// Types
export type {} from './types';
