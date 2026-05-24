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
 * Builds a weighted tsvector SQL expression and corresponding parameters.
 * Groups texts by weight category and creates setweight() calls for each.
 */
function buildWeightedVectorSql(texts: WeightedText[]): {
  sql: string;
  params: Record<string, string>;
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
  const params: Record<string, string> = {};

  for (const weight of ['A', 'B', 'C', 'D'] as TsVectorWeight[]) {
    const groupTexts = weightGroups[weight];
    if (groupTexts.length > 0) {
      const paramName = `searchText${weight}`;
      sqlParts.push(`setweight(to_tsvector('english', :${paramName}), '${weight}')`);
      params[paramName] = groupTexts.join(' ');
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
    const { sql: vectorSql, params: vectorParams } = buildWeightedVectorSql(data.searchableText);

    return this.vectorRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(VectorEntity);

      const existing = await repo.findOne({
        where: {
          entityType: data.entityType,
          entityId: data.entityId,
          userId: context.userId,
        },
      });

      if (existing == null) {
        const id = uuidv7();

        let queryBuilder = repo
          .createQueryBuilder()
          .insert()
          .into(VectorEntity)
          .values({
            id: id,
            entityType: data.entityType,
            entityId: data.entityId,
            vector: () => vectorSql,
            userId: context.userId,
          });

        // Set all weight parameters
        for (const [paramName, paramValue] of Object.entries(vectorParams)) {
          queryBuilder = queryBuilder.setParameter(paramName, paramValue);
        }

        await queryBuilder.returning('*').execute();

        const entity = await repo.findOne({
          where: {
            id,
          },
        });

        return entity ? VectorEntity.toEgressType(entity) : null;
      }

      let queryBuilder = repo
        .createQueryBuilder()
        .update(VectorEntity)
        .set({
          vector: () => vectorSql,
        })
        .where('id = :id', {
          id: existing.id,
        });

      // Set all weight parameters
      for (const [paramName, paramValue] of Object.entries(vectorParams)) {
        queryBuilder = queryBuilder.setParameter(paramName, paramValue);
      }

      await queryBuilder.returning('*').execute();

      const entity = await repo.findOne({
        where: {
          id: existing.id,
        },
      });

      return entity ? VectorEntity.toEgressType(entity) : null;
    });
  }

  async remove(context: ServiceContext, data: RemoveVectorDto): Promise<boolean> {
    const result = await this.vectorRepo.delete({
      entityType: data.entityType,
      entityId: data.entityId,
    });

    return result.affected ? result.affected > 0 : false;
  }
}
