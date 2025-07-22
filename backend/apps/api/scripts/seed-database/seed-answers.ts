import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { AnswerEntity } from '@ci/domains/intelligence';

import { readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedAnswers(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    user_id: string;
    question_id: string;
    give_answer_1: string;
  };

  const records = readCsv<CsvRecord>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      await manager.save(AnswerEntity, {
        id: record.id,
        give_answer_1: record.give_answer_1,
        user: {
          id: record.user_id,
        },
        question: {
          id: record.question_id,
        },
      });
    }
  });

  logger.log(`Seeded ${records.length} answer records`);
}
