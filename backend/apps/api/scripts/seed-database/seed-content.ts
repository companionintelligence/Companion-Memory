import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { ContentEntity } from '@ci/domains/memory';

import { getOrCreateTags, parseTags, readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedContent(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    type: string;
    title: string;
    text: string;
    url: string;
    mimetype: string;
    embed_content: string;
    embed_format: string;
    embed_thumnail: string;
    hidden: boolean;
    price: number;
    remote_id: string;
    provider_name: string;
    user_id: string;
    connection_id: string;
    provider_id: string;
    tags: string;
    created_at: Date;
    udpated_at: Date;
  };

  const records = readCsv<CsvRecord>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      const tagNames = parseTags(record.tags);
      const tags = await getOrCreateTags(manager, record.user_id, tagNames);

      await manager.save(ContentEntity, {
        id: record.id,
        type: record.type,
        title: record.title,
        text: record.text,
        url: record.url,
        mimetype: record.mimetype,
        user: {
          id: record.user_id,
        },
        tags,
        created_at: record.created_at,
        updated_at: record.created_at,
      });
    }
  });

  logger.log(`Seeded ${records.length} content records`);
}
