import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { ActionEntity } from '@ci/domains/intelligence';

import { getOrCreateTags, parseTags, readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedActions(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    title: string;
    text: string;
    image_url: string;
    thread_id: string;
    user_id: string;
    tags: string;
  };

  const records = readCsv<CsvRecord>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      const tagNames = parseTags(record.tags);
      const tags = await getOrCreateTags(manager, record.user_id, tagNames);

      await manager.save(ActionEntity, {
        id: record.id,
        title: record.title,
        text: record.text,
        imageUrl: record.image_url,
        thread: {
          id: record.thread_id,
        },
        user: {
          id: record.user_id,
        },
        tags,
      });
    }
  });

  logger.log(`Seeded ${records.length} action records`);
}
