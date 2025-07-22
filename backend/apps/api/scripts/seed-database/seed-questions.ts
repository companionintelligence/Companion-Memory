import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { QuestionEntity } from '@ci/domains/intelligence';

import { readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedQuestions(db: DataSource, filePath: string) {
  type CsvQuestion = {
    id: string;
    category: string;
    user_id: string;
    question_string: string;
    example_answer_1: string;
  };

  const records = readCsv<CsvQuestion>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      await manager.save(QuestionEntity, {
        id: record.id,
        category: record.category,
        text: record.question_string,
        example_answer_1: record.example_answer_1,
      });
    }
  });

  logger.log(`Seeded ${records.length} question records`);
}
