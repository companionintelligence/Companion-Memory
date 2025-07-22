import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { LocationEntity } from '@ci/domains/memory';

import { getOrCreateTags, parseTags, readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedLocations(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    identifier: string;
    datetime: Date;
    geo_format: string;
    geolocation: string;
    estimated: boolean;
    tracked: boolean;
    uploaded: boolean;
    place_id: string;
    user_id: string;
    connection_id: string;
    provider_id: string;
    tags: string;
    created_at: Date;
    updated_at: Date;
  };

  const records = readCsv<CsvRecord>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      const tagNames = parseTags(record.tags);
      const tags = await getOrCreateTags(manager, record.user_id, tagNames);

      await manager.save(LocationEntity, {
        id: record.id,
        identifier: record.identifier,
        datetime: record.datetime,
        geo_format: record.geo_format,
        geolocation: JSON.parse(record.geolocation),
        estimated: record.estimated,
        tracked: record.tracked,
        uploaded: record.uploaded,
        user: {
          id: record.user_id,
        },
        place: {
          id: record.place_id,
        },
        tags,
        created_at: record.created_at,
        updated_at: record.updated_at,
      });
    }
  });

  logger.log(`Seeded ${records.length} location records`);
}
