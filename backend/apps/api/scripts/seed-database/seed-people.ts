import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { PersonEntity } from '@ci/domains/memory';

import { getOrCreateTags, parseTags, readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedPeople(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    type: string;
    first_name: string;
    last_name: string;
    middle_name: string;
    gender: string;
    address: string;
    street_address: string;
    street_address_2: string;
    city: string;
    region: string;
    country: string;
    postal_code: string;
    avatar_url: string;
    external_avatar_url: string;
    hidden: boolean;
    user_id: string;
    connection_id: string;
    contact_ids: unknown;
    tags: string;
    created_at: Date;
    udpated_at: Date;
  };

  const records = readCsv<CsvRecord>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      const tagNames = parseTags(record.tags);
      const tags = await getOrCreateTags(manager, record.user_id, tagNames);

      await manager.save(PersonEntity, {
        id: record.id,
        type: record.type,
        first_name: record.first_name,
        last_name: record.last_name,
        gender: record.gender,
        address: record.address,
        street_address: record.street_address,
        street_address_2: record.street_address_2,
        city: record.city,
        region: record.region,
        country: record.country,
        postal_code: record.postal_code,
        avatar_url: record.avatar_url,
        user: {
          id: record.user_id,
        },
        tags,
        created_at: record.created_at,
        updated_at: record.created_at,
      });
    }
  });

  logger.log(`Seeded ${records.length} person records`);
}
