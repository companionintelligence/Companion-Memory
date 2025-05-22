import { KnexService } from '@feathersjs/knex';
import type { Knex } from 'knex';
import { toSql, fromSql } from 'pgvector';

export class VectorService extends KnexService {
  constructor(db: Knex) {
    super({
      Model: db,
      name: 'vectors',
      id: 'id',
    });
  }

  async create(data: any, params?: any) {
    // Convert JS array to pgvector SQL format
    if (Array.isArray(data.embedding)) {
      data.embedding = toSql(data.embedding);
    }
    return super.create(data, params);
  }

  async find(params?: any) {
    const result = await super.find(params);
    // Convert SQL vector to JS array if needed
    if (Array.isArray(result.data)) {
      result.data = result.data.map((row: any) => ({
        ...row,
        embedding: fromSql(row.embedding),
      }));
    }
    return result;
  }
}
