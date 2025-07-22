import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { EventEntity } from '@ci/domains/memory';

import { readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedEvents(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    type: string;
    name: string;
    description: string;
    start_time: Date;
    end_time: Date;
    related_objects: unknown;
    data_source: unknown;
    user_id: string;
    connection_id: string;
    provider_id: string;
    created_at: Date;
    updated_at: Date;
  };

  const records = readCsv<CsvRecord>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      await manager.save(EventEntity, {
        id: record.id,
        type: record.type,
        name: record.name,
        description: record.description,
        user: {
          id: record.user_id,
        },
        created_at: record.created_at,
        updated_at: record.updated_at,
      });
    }
  });

  logger.log(`Seeded ${records.length} event records`);
}
