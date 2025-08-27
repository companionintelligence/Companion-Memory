import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { MessageEntity } from '@ci/domains/conversations';

import { readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedMessages(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    model: string;
    text: string;
    mimetype: string;
    canceled: boolean;
    user_id: string;
    thread_id: string;
    role: string;
  };

  const records = readCsv<CsvRecord>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      await manager.save(MessageEntity, {
        id: record.id,
        model: record.model,
        role: record.role,
        text: record.text,
        mimetype: record.mimetype,
        canceled: record.canceled,
        user: {
          id: record.user_id,
        },
        thread: {
          id: record.thread_id,
        },
      });
    }
  });

  logger.log(`Seeded ${records.length} message records`);
}
