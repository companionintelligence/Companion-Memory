import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { PlaceEntity } from '@ci/domains/memory';

import { getOrCreateTags, parseTags, readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedPlaces(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    type: string;
    name: string;
    geo_format: string;
    geolocation: string;
    location_boundary: string;
    estimated: boolean;
    tracked: boolean;
    uploaded: boolean;
    parent_id: string;
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

      await manager.save(PlaceEntity, {
        id: record.id,
        type: record.type,
        name: record.name,
        geo_format: record.geo_format,
        geolocation: JSON.parse(record.geolocation),
        location_boundary: JSON.parse(record.location_boundary),
        estimated: record.estimated,
        tracked: record.tracked,
        uploaded: record.uploaded,
        user: {
          id: record.user_id,
        },
        parent: {
          id: record.parent_id,
        },
        tags,
        created_at: record.created_at,
        updated_at: record.updated_at,
      });
    }
  });

  logger.log(`Seeded ${records.length} place records`);
}
