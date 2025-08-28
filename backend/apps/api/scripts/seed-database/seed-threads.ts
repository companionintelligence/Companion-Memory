import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { ThreadEntity } from '@ci/domains/conversations';

import { readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedThreads(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    name: string;
    model: string;
    description: string;
    user_id: string;
  };

  const records = readCsv<CsvRecord>(filePath);

  console.log('creating thread records', records);
  await db.transaction(async (manager) => {
    for (const record of records) {
      console.log('creating thread record', record);
      await manager.save(ThreadEntity, {
        id: record.id,
        name: record.name,
        model: record.model,
        description: record.description,
        user: {
          id: record.user_id,
        },
      });
    }
  });

  logger.log(`Seeded ${records.length} thread records`);
}
