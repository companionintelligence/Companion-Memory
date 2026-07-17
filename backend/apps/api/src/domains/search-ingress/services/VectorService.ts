import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext } from '@ci/common/context';

import { type Vector, VectorEntity } from '../entities/VectorEntity';
import { UpsertVectorDto, RemoveVectorDto, WeightedText } from '../types';

type TsVectorWeight = 'A' | 'B' | 'C' | 'D';

/**
 * Maps a scalar weight to PostgreSQL tsvector weight category.
 * Higher scalars map to higher-priority categories.
 */
function mapScalarToWeight(scalar: number): TsVectorWeight {
  if (scalar >= 8) {
    return 'A';
  }

  if (scalar >= 4) {
    return 'B';
  }

  if (scalar >= 2) {
    return 'C';
  }

  return 'D';
}

/**
 * Builds a weighted tsvector SQL expression using POSITIONAL ($n) placeholders
 * starting at `startIndex`, plus the ordered param values. Groups texts by weight
 * category and emits one setweight() call per non-empty group. Positional (not
 * named) params so the expression can be spliced into a raw parameterized
 * `INSERT ... ON CONFLICT` upsert.
 */
function buildWeightedVectorSql(
  texts: WeightedText[],
  startIndex: number,
): {
  sql: string;
  params: string[];
} {
  // Group texts by weight category
  const weightGroups: Record<TsVectorWeight, string[]> = { A: [], B: [], C: [], D: [] };

  for (const item of texts) {
    if (item.text && item.text.trim().length > 0) {
      const weight = mapScalarToWeight(item.weight);
      weightGroups[weight].push(item.text.trim());
    }
  }

  // Build SQL parts for each non-empty weight group
  const sqlParts: string[] = [];
  const params: string[] = [];
  let paramIndex = startIndex;

  for (const weight of ['A', 'B', 'C', 'D'] as TsVectorWeight[]) {
    const groupTexts = weightGroups[weight];
    if (groupTexts.length > 0) {
      sqlParts.push(`setweight(to_tsvector('english', $${paramIndex}), '${weight}')`);
      params.push(groupTexts.join(' '));
      paramIndex += 1;
    }
  }

  // If no text at all, create empty tsvector
  const sql = sqlParts.length > 0 ? sqlParts.join(' || ') : "''::tsvector";

  return { sql, params };
}

@Injectable()
export class VectorService {
  constructor(
    @InjectRepository(VectorEntity)
    private readonly vectorRepo: Repository<VectorEntity>,
  ) {}

  async upsert(context: UserServiceContext, data: UpsertVectorDto): Promise<Vector | null> {
    // Single-statement upsert on the (entity_type, entity_id) unique key. The
    // weighted tsvector is computed inline in the INSERT and copied via
    // EXCLUDED.vector on conflict. Replaces the previous SELECT-then-
    // INSERT/UPDATE-then-SELECT wrapped in an explicit transaction — the per-row
    // cost that left the search-index queue >95% undrained.
    //
    // Positional params: $1 id, $2 entity_type, $3 entity_id, $4..$(3+k) the k
    // tsvector weight groups, then user_id last.
    const { sql: vectorSql, params: vectorParams } = buildWeightedVectorSql(data.searchableText, 4);
    const userIdIndex = 4 + vectorParams.length;

    const rows: Array<{
      id: string;
      entity_type: string;
      entity_id: string;
      user_id: string;
      created_at: Date;
      updated_at: Date;
    }> = await this.vectorRepo.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES ($1, $2, $3, ${vectorSql}, $${userIdIndex})
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET vector = EXCLUDED.vector, updated_at = now()
       RETURNING id, entity_type, entity_id, user_id, created_at, updated_at`,
      [uuidv7(), data.entityType, data.entityId, ...vectorParams, context.userId],
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

  async remove(context: ServiceContext, data: RemoveVectorDto): Promise<boolean> {
    const result = await this.vectorRepo.delete({
      entityType: data.entityType,
      entityId: data.entityId,
    });

    return result.affected ? result.affected > 0 : false;
  }
}
