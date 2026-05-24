import { Injectable } from '@nestjs/common';
import { Ollama } from 'ollama';

import config from '@ci/configuration';

const EMBEDDING_MODEL = 'nomic-embed-text';

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
      model: EMBEDDING_MODEL,
      prompt: input,
    });

    if (response.embedding == null || response.embedding.length === 0) {
      throw new Error('Received empty embedding vector');
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
