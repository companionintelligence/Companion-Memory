import path from 'path';

import { Logger } from '@nestjs/common';
import bcrypt from 'bcrypt';
import type { DataSource } from 'typeorm';

import config from '@ci/configuration';
import { UserEntity } from '@ci/domains/user';

import { readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedUsers(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    created_at: Date;
    updated_at: Date;
  };

  const records = readCsv<CsvRecord>(filePath);

  if (process.env.AUTH_DEFAULT_USER_PASSWORD == null) {
    throw new Error('Default user password not specified');
  }

  await db.transaction(async (manager) => {
    for (const record of records) {
      await manager.save(UserEntity, {
        id: record.id,
        name: `${record.first_name} ${record.last_name}`,
        email: record.email,
        password: await bcrypt.hash(process.env.AUTH_DEFAULT_USER_PASSWORD!, config.auth.local.saltRounds),
        created_at: record.created_at,
        updated_at: record.updated_at,
      });
    }
  });

  logger.log(`Seeded ${records.length} user records`);
}
