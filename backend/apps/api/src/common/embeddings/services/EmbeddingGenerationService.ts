import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

import config from '@ci/configuration';

@Injectable()
export class EmbeddingGenerationService {
  // Embeddings go through the CI Hub's OpenAI-compatible `/v1` proxy. When the
  // Hub provides no apiBase we fall back to a local Ollama, which serves an
  // OpenAI-compatible API at `<host>/v1`.
  private readonly client = new OpenAI({
    baseURL: config.llm.apiBase ?? `${config.services.ollama.host.replace(/\/+$/, '')}/v1`,
    apiKey: config.llm.apiKey ?? 'ollama',
  });

  /**
   * Generate an embedding vector for a given text input.
   */
  async generateEmbedding(input: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: config.llm.embeddingModel,
      input,
    });

    const embedding = response.data[0]?.embedding;

    if (embedding == null || embedding.length === 0) {
      throw new Error('Received empty embedding vector');
    }

    // The pgvector schema is hard-coupled to a fixed dimension. Refuse a model
    // whose output width would silently corrupt the vector store.
    if (embedding.length !== config.llm.embeddingDimensions) {
      throw new Error(
        `Embedding model "${config.llm.embeddingModel}" returned ${embedding.length} dimensions, ` +
          `but the pgvector schema requires ${config.llm.embeddingDimensions}. ` +
          `Pin a ${config.llm.embeddingDimensions}-dimension model (e.g. nomic-embed-text).`,
      );
    }

    return embedding;
  }

  /**
   * Generate an embedding vector as a PostgreSQL-compatible string.
   */
  async generateEmbeddingString(input: string): Promise<string> {
    const vector = await this.generateEmbedding(input);

    return `[${vector.join(',')}]`;
  }
}
