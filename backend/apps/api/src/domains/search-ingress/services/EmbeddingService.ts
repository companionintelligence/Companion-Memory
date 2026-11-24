import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { searchDocumentHash } from '@ci/common/embeddings';

import { type Embedding, EmbeddingEntity } from '../entities/EmbeddingEntity';
import { UpsertEmbeddingDto, UpsertEmbeddingDocumentDto, RemoveEmbeddingDto } from '../types';

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
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, embedding, user_id, source_hash)
       VALUES ($1, $2, $3, $4::vector, $5, $6)
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET embedding = EXCLUDED.embedding, source_hash = EXCLUDED.source_hash, updated_at = now()
       RETURNING id, entity_type, entity_id, user_id, created_at, updated_at`,
      [uuidv7(), data.entityType, data.entityId, embeddingLiteral, context.userId, data.sourceHash ?? null],
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

  /**
   * Embed a row's search document and store the vector — unless the stored
   * vector was made from this same document by the same model, in which case
   * nothing is sent to the model and nothing is written.
   *
   * The live listeners call this on every `*CreatedEvent` / `*UpdatedEvent`,
   * and an update fires on any field change: a re-labelled photo, a re-dated
   * event, a tag. The document those rows embed had not changed, and each one
   * cost a model call and a vector write anyway. `generate` is the caller's
   * model call, made only when it is needed.
   */
  async upsertDocument(
    context: UserServiceContext,
    data: UpsertEmbeddingDocumentDto,
    generate: (text: string) => Promise<number[]>,
  ): Promise<'embedded' | 'unchanged'> {
    const sourceHash = searchDocumentHash(data.text);
    const rows: Array<{ source_hash: string | null }> = await this.embeddingRepo.query(
      `SELECT source_hash FROM ci_search.embeddings WHERE entity_type = $1 AND entity_id = $2`,
      [data.entityType, data.entityId],
    );

    if (rows[0]?.source_hash === sourceHash) {
      return 'unchanged';
    }

    const embedding = await generate(data.text);

    await this.upsert(context, {
      entityType: data.entityType,
      entityId: data.entityId,
      embedding,
      sourceHash,
    });

    return 'embedded';
  }

  /**
   * Which of `entityIds` already have an embedding of `entityType` for this user.
   * Lets a re-index (the maintenance sweep re-driving a listener for rows that
   * lack a device document) skip the model call for rows whose vector exists.
   */
  async existingEntityIds(
    context: UserServiceContext,
    entityType: string,
    entityIds: readonly string[],
  ): Promise<Set<string>> {
    if (entityIds.length === 0) {
      return new Set();
    }

    const rows: Array<{ entity_id: string }> = await this.embeddingRepo.query(
      `SELECT entity_id FROM ci_search.embeddings
        WHERE entity_type = $1 AND user_id = $2 AND entity_id = ANY($3::uuid[])`,
      [entityType, context.userId, [...entityIds]],
    );

    return new Set(rows.map((row) => row.entity_id));
  }

  async remove(context: ServiceContext, data: RemoveEmbeddingDto): Promise<boolean> {
    const result = await this.embeddingRepo.delete({
      entityType: data.entityType,
      entityId: data.entityId,
    });

    return result.affected ? result.affected > 0 : false;
  }
}
