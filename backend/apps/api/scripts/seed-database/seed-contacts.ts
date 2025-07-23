import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { ContactEntity } from '@ci/domains/memory';

import { getOrCreateTags, parseTags, readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedContacts(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    avatar_url: string;
    handle: string;
    hidden: boolean;
    identifier: string;
    name: string;
    provider_name: string;
    remote_id: string;
    person_id: string;
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

      await manager.save(ContactEntity, {
        id: record.id,
        avatar_url: record.avatar_url,
        handle: record.handle,
        identifier: record.identifier,
        user: {
          id: record.user_id,
        },
        person: {
          id: record.person_id,
        },
        tags,
        created_at: record.created_at,
        updated_at: record.created_at,
      });
    }
  });

  logger.log(`Seeded ${records.length} contact records`);
}
