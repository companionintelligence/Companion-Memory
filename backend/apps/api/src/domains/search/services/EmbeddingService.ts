import crypto from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import dlv from 'dlv';
import ollama from 'ollama';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { getIndexableMetadata } from '@ci/common/decorators';
import type { RequestContext } from '@ci/common/types';

import { EmbeddingEntity } from '../entities/EmbeddingEntity';

// 768 dimension model, hard coded for now, but doesn't need to stay this way
// Note: We can consider downsampling by:
//
//   * Truncate: embedding.slice(0, 384)
//   * Pool: chunk & average
//   * PCA or UMAP (offline dimensionality reduction)
//
// All of these will reduce semantic accuracy and we'd to research and consider
// the tradeoffs.
const EMBEDDING_MODEL = 'nomic-embed-text';

interface Entity {
  id: string;
  user?: {
    id: string;
  };
}

@Injectable()
export class EmbeddingService {
  constructor(
    @InjectRepository(EmbeddingEntity)
    private embeddingRepo: Repository<EmbeddingEntity>,
  ) {}

  async indexText(context: RequestContext, input: string) {
    return this.indexGeneric(context, input, undefined, undefined, undefined);
  }

  async indexEntity(entity: Entity, dataPath: string) {
    let type, validPaths;

    if (entity) {
      const metadata = getIndexableMetadata(entity);

      if (!metadata) {
        throw new Error(`Entity is not indexable: ${entity.constructor.name}`);
      }

      ({ type, validPaths } = metadata);

      // The assertion on `dataPath` should be safe assuming invocations of `indexGeneric` force
      // `dataPath` to be a string if `entity` is an entity. See `indexEntity`.
      if (!validPaths.has(dataPath!)) {
        throw new Error(`Invalid data path: ${dataPath}`);
      }
    }

    const context = { userId: entity.user?.id };
    const input = String(dlv(entity, dataPath) ?? '');

    return this.indexGeneric(context, input, type, entity.id, dataPath);
  }

  async findAll(context: RequestContext): Promise<EmbeddingEntity[]> {
    return this.embeddingRepo.find({
      where: {
        user: {
          id: context.userId,
        },
      },
    });
  }

  async findNearest(
    context: RequestContext,
    input: string,
    type?: string,
    topK: number = 25,
  ): Promise<EmbeddingEntity[]> {
    const vector = await this.calculateVectorString(input);

    // FIXME: This feels like it's ripe for injection. Just... be aware. Or at least confirm it's not, I don't remember if I did.

    let sql = `SELECT *, embedding_vector <-> $1 as distance FROM embeddings WHERE 1 = 1`;

    const params: (string | number)[] = [vector];

    let paramIndex = 2;

    if (context.userId) {
      sql += ` AND user_id = $${paramIndex}`;

      params.push(context.userId);

      paramIndex++;
    }

    if (type) {
      sql += ` AND entity_type = $${paramIndex}`;

      params.push(type);

      paramIndex++;
    }

    sql += ` ORDER BY distance ASC LIMIT $${paramIndex}`;

    params.push(topK);

    const result = await this.embeddingRepo.query(sql, params);

    return result.map((entity: EmbeddingEntity) => ({
      text: entity.raw_input,
      type: entity.entity_type,
      id: entity.entity_id,
      path: entity.data_path,
    }));
  }

  private async indexGeneric(
    context: RequestContext,
    input: string,
    entityType: string | undefined,
    entityId: string | undefined,
    dataPath: string | undefined,
  ) {
    const hashedInput = await this.sha256(input);

    const existing = await this.embeddingRepo.find({
      where: {
        model: EMBEDDING_MODEL,
        raw_input_hash: hashedInput,
        entity_type: entityType,
        entity_id: entityId,
        data_path: dataPath,
        ...(context.userId && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    const match = existing.find((embedding) => embedding.raw_input === input);

    if (match) {
      return match.embedding_vector;
    }

    const vector = await this.calculateVector(input);

    await this.embeddingRepo.save({
      id: uuidv7(),
      model: EMBEDDING_MODEL,
      raw_input: input,
      raw_input_hash: hashedInput,
      entity_type: entityType,
      entity_id: entityId,
      data_path: dataPath,
      embedding_vector: vector,
      ...(context.userId && {
        user: {
          id: context.userId,
        },
      }),
    });

    return vector;
  }

  private async sha256(input: string) {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  private async calculateVector(input: string) {
    const response = await ollama.embeddings({
      model: EMBEDDING_MODEL,
      prompt: input,
    });

    return response.embedding;
  }

  private async calculateVectorString(input: string) {
    const vector = await this.calculateVector(input);

    return `[${vector.join(',')}]`;
  }
}
