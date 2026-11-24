import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { AnswerService } from '@ci/domains/intelligence';

import { SEED_USER_ID } from './data/users';
import { readCsv } from './utils';

export async function seedAnswers(module: TestingModule, multibar: MultiBar, filePath: string) {
  // Every row's user_id column is the hardcoded John Smith id, so this seeder
  // is the one that would not follow SEED_USER_ID. Ignore the column and use
  // the resolved seed user, keeping answers with the rest of the dataset.
  type CsvRecord = {
    id: string;
    user_id: string;
    question_id: string;
    give_answer_1: string;
  };

  const records = readCsv<CsvRecord>(filePath);

  const answerService = module.get(AnswerService);

  const bar = multibar.create(records.length, 0, { task: 'Answers' });

  for (const record of records) {
    const existingAnswer = await answerService.findById(
      {
        userId: SEED_USER_ID,
      },
      record.id,
    );

    if (existingAnswer == null) {
      await answerService.create(
        {
          userId: SEED_USER_ID,
        },
        {
          id: record.id,
          question: {
            id: record.question_id,
          },
          text: record.give_answer_1,
          answerSource: 'imported',
          answerMethod: 'survey',
          isSensitive: false,
          sharingLevel: 'private',
        },
      );
    }

    bar.increment();
  }

  bar.stop();
}
