import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { ThreadService } from '@ci/domains/conversations';

import { THREADS } from './data/threads';

export async function seedThreads(module: TestingModule, multibar: MultiBar) {
  const threadService = module.get(ThreadService);

  const bar = multibar.create(THREADS.length, 0, { task: 'Threads' });

  for (const record of THREADS) {
    const existingThread = await threadService.findById(
      {
        userId: record.userId,
      },
      record.id,
    );

    if (existingThread == null) {
      await threadService.create(
        {
          userId: record.userId,
        },
        {
          id: record.id,
          name: record.name,
          model: record.model,
          description: record.description,
        },
      );
    }

    bar.increment();
  }

  bar.stop();
}
