import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { UserServiceContext } from '@ci/common/types';

import { EmbeddingEntity } from '../entities/EmbeddingEntity';
import { SearchResult, RawEmbedding } from '../types';

@Injectable()
export class SearchService {
  constructor(
    @InjectRepository(EmbeddingEntity)
    private readonly embeddingRepo: Repository<EmbeddingEntity>,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
  ) {}

  async searchByQuery(
    context: UserServiceContext,
    query: string,
    topK: number = 25,
  ): Promise<SearchResult[]> {
    const vector = await this.embeddingGenerationService.generateEmbeddingString(query);

    const params: (string | number)[] = [vector, context.userId];

    const sql = `
      SELECT
        entity_type,
        entity_id,
        id,
        embedding <-> $1 as distance,
        user_id
      FROM ci_search.embeddings
      WHERE user_id = $2
      ORDER BY distance ASC LIMIT ${topK}
    `;

    const results = await this.embeddingRepo.query(sql, params);

    return results.map((row: RawEmbedding) => {
      return {
        type: row.entity_type,
        entityId: row.entity_id,
      };
    });
  }
}
