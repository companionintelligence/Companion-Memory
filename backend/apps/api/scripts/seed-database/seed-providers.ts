import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { ProviderEntity } from '@ci/domains/connections';

import { readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedProviders(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    name: string;
    token_host?: string;
    token_path?: string;
    authorize_path?: string;
    api_base_url?: string;
    scopes?: string;
    created_at: Date;
    updated_at: Date;
  };

  const records = readCsv<CsvRecord>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      await manager.save(ProviderEntity, {
        id: record.id,
        name: record.name,
        tokenHost: record.token_host || null,
        tokenPath: record.token_path || null,
        authorizePath: record.authorize_path || null,
        apiBaseUrl: record.api_base_url || null,
        scopes: record.scopes || null,
        created_at: record.created_at,
        updated_at: record.updated_at,
      });
    }
  });

  logger.log(`Seeded ${records.length} provider records`);
}
