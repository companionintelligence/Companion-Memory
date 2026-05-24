import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { MessageService } from '@ci/domains/conversations';

import { MESSAGES } from './data/messages';

export async function seedMessages(module: TestingModule, multibar: MultiBar) {
  const messageService = module.get(MessageService);

  const bar = multibar.create(MESSAGES.length, 0, { task: 'Messages' });

  for (const record of MESSAGES) {
    const existingMessage = await messageService.findById(
      {
        userId: record.userId,
      },
      record.id,
    );

    if (existingMessage == null) {
      await messageService.create(
        {
          userId: record.userId,
        },
        {
          id: record.id,
          model: record.model,
          role: record.role,
          content: record.content,
          mimetype: record.mimetype,
          canceled: Boolean(record.canceled),
          threadId: record.threadId,
        },
      );
    }

    bar.increment();
  }

  bar.stop();
}
