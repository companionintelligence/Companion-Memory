import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { ActionService } from '@ci/domains/intelligence';
import { TagService } from '@ci/domains/search-next';

import { ACTIONS } from './data/actions';

export async function seedActions(module: TestingModule, multibar: MultiBar) {
  const actionService = module.get(ActionService);
  const tagService = module.get(TagService);

  const bar = multibar.create(ACTIONS.length, 0, { task: 'Actions' });

  for (const record of ACTIONS) {
    const existingAction = await actionService.findById(
      {
        userId: record.userId,
      },
      record.id,
    );

    if (existingAction == null) {
      await actionService.create(
        {
          userId: record.userId,
        },
        {
          id: record.id,
          title: record.title,
          text: record.text,
          imageUrl: record.imageUrl,
          threadId: record.threadId,
        },
      );

      await tagService.tagEntities(
        {
          userId: record.userId,
        },
        {
          labels: record.tags,
          entities: [
            {
              type: 'action',
              id: record.id,
            },
          ],
        },
      );
    }

    bar.increment();
  }

  bar.stop();
}
