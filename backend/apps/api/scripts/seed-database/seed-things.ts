import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { ThingEntity } from '@ci/domains/memory';

import { getOrCreateTags, parseTags, readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedThings(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    type: string;
    name: string;
    description: string;
    dimensions: string;
    weight: string;
    user_id: string;
    connection_id: string;
    tags: string;
  };

  const records = readCsv<CsvRecord>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      const tagNames = parseTags(record.tags);
      const tags = await getOrCreateTags(manager, record.user_id, tagNames);

      await manager.save(ThingEntity, {
        id: record.id,
        type: record.type,
        name: record.name,
        description: record.description,
        user: {
          id: record.user_id,
        },
        tags,
      });
    }
  });

  logger.log(`Seeded ${records.length} thing records`);
}
