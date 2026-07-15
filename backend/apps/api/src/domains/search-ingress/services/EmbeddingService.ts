import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext } from '@ci/common/context';

import { type Embedding, EmbeddingEntity } from '../entities/EmbeddingEntity';
import { UpsertEmbeddingDto, RemoveEmbeddingDto } from '../types';

@Injectable()
export class EmbeddingService {
  constructor(
    @InjectRepository(EmbeddingEntity)
    private readonly embeddingRepo: Repository<EmbeddingEntity>,
  ) {}

  async upsert(context: UserServiceContext, data: UpsertEmbeddingDto): Promise<Embedding | null> {
    // Single-statement upsert on the (entity_type, entity_id) unique key. Replaces
    // the previous SELECT-then-INSERT/UPDATE-then-SELECT run inside an explicit
    // transaction (3 statements + BEGIN/COMMIT) — a per-row cost that left >95% of
    // the search-index queue undrained. `embedding` is vector(768); the pgvector
    // text literal `[a,b,c]` mirrors the entity's column transformer.
    const embeddingLiteral = `[${data.embedding.join(',')}]`;

    const rows: Array<{
      id: string;
      entity_type: string;
      entity_id: string;
      user_id: string;
      created_at: Date;
      updated_at: Date;
    }> = await this.embeddingRepo.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, embedding, user_id)
       VALUES ($1, $2, $3, $4::vector, $5)
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = now()
       RETURNING id, entity_type, entity_id, user_id, created_at, updated_at`,
      [uuidv7(), data.entityType, data.entityId, embeddingLiteral, context.userId],
    );

    const row = rows[0];

    return row
      ? {
          id: row.id,
          entityType: row.entity_type,
          entityId: row.entity_id,
          userId: row.user_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  async remove(context: ServiceContext, data: RemoveEmbeddingDto): Promise<boolean> {
    const result = await this.embeddingRepo.delete({
      entityType: data.entityType,
      entityId: data.entityId,
    });

    return result.affected ? result.affected > 0 : false;
  }
}
