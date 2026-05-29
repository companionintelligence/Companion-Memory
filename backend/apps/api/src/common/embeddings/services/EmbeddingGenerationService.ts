import { Injectable } from '@nestjs/common';
import { Ollama } from 'ollama';

import config from '@ci/configuration';

@Injectable()
export class EmbeddingGenerationService {
  private readonly ollama = new Ollama({
    host: config.services.ollama.host,
  });

  /**
   * Generate an embedding vector for a given text input.
   */
  async generateEmbedding(input: string): Promise<number[]> {
    const response = await this.ollama.embeddings({
      model: config.llm.embeddingModel,
      prompt: input,
    });

    if (response.embedding == null || response.embedding.length === 0) {
      throw new Error('Received empty embedding vector');
    }

    // The pgvector schema is hard-coupled to a fixed dimension. Refuse a model
    // whose output width would silently corrupt the vector store.
    if (response.embedding.length !== config.llm.embeddingDimensions) {
      throw new Error(
        `Embedding model "${config.llm.embeddingModel}" returned ${response.embedding.length} dimensions, ` +
          `but the pgvector schema requires ${config.llm.embeddingDimensions}. ` +
          `Pin a ${config.llm.embeddingDimensions}-dimension model (e.g. nomic-embed-text).`,
      );
    }

    return response.embedding;
  }

  /**
   * Generate an embedding vector as a PostgreSQL-compatible string.
   */
  async generateEmbeddingString(input: string): Promise<string> {
    const vector = await this.generateEmbedding(input);

    return `[${vector.join(',')}]`;
  }
}
