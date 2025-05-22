import { KnexService } from '@feathersjs/knex';
import type { Knex } from 'knex';
import { toSql, fromSql } from 'pgvector';
import type { Params } from '@feathersjs/feathers';

export class VectorService extends KnexService {
  constructor(db: Knex) {
    super({
      Model: db,
      name: 'vectors',
      id: 'id',
    });
  }

  async create(data: any, params?: any) {
    // Support both single and batch create
    if (Array.isArray(data)) {
      return super.create(
        data.map((item) => ({
          ...item,
          embedding: Array.isArray(item.embedding) ? toSql(item.embedding) : item.embedding,
        })),
        params,
      );
    } else {
      if (Array.isArray(data.embedding)) {
        data.embedding = toSql(data.embedding);
      }
      return super.create(data, params);
    }
  }

  async find(params?: any) {
    const result = await super.find(params);
    // Handle both paginated and non-paginated results
    if (Array.isArray(result)) {
      return result.map((row) => ({
        ...row,
        embedding: typeof row.embedding === 'string' ? fromSql(row.embedding) : row.embedding,
      }));
    } else if (result && Array.isArray(result.data)) {
      result.data = result.data.map((row) => ({
        ...row,
        embedding: typeof row.embedding === 'string' ? fromSql(row.embedding) : row.embedding,
      }));
      return result;
    }
    return result;
  }
}
