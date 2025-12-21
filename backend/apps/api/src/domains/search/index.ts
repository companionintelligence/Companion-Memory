/**
 * This module is responsible for creating, storing, and searching vector embeddings.
 * It forms the foundation of the application's semantic search capabilities, allowing
 * the system to understand and retrieve information based on meaning rather than just
 * keywords.
 *
 * ### Key Components:
 * - **`EmbeddingService`**: The central service that handles the generation of embeddings
 *   from text or other data and performs similarity searches against the vector database.
 * - **`EmbeddingController`**: Provides API endpoints to manually trigger embedding
 *   processes or execute search queries.
 * - **`TagEntity`**: A database entity for managing tags, which can be used to categorize
 *   and filter search results.
 *
 * ### Module Integration:
 * - This module is a core dependency for any domain that needs to make its content
 *   searchable, such as `IntelligenceModule` (for finding relevant context for questions)
 *   and `MemoryModule` (for searching the knowledge graph).
 *
 * @module EmbeddingModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmbeddingController } from './controllers/EmbeddingController';
import { TagEntity } from './entities/TagEntity';
import { EmbeddingService } from './services/EmbeddingService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([TagEntity])],
  providers: [EmbeddingService],
  controllers: [EmbeddingController],
  exports: [EmbeddingService],
})
export class EmbeddingModule {}

// Entities
export { TagEntity };

// Services
export { EmbeddingService };

// Types
export type {} from './types';
