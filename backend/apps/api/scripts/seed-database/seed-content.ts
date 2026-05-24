import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { ContentService } from '@ci/domains/memory';
import { TagService } from '@ci/domains/search-next';

import { CONTENT } from './data/content';
import { JOHN_SMITH } from './data/users';

export async function seedContent(module: TestingModule, multibar: MultiBar) {
  const contentService = module.get(ContentService);
  const tagService = module.get(TagService);

  const bar = multibar.create(CONTENT.length, 0, { task: 'Content' });

  for (const content of CONTENT) {
    const existingContent = await contentService.findById(
      {
        userId: JOHN_SMITH.id,
      },
      content.id,
    );

    if (existingContent == null) {
      await contentService.create(
        {
          userId: JOHN_SMITH.id,
        },
        {
          id: content.id,
          type: content.type,
          title: content.title,
          text: content.text,
          url: content.url,
          mimetype: content.mimetype,
          ...(content.source_data && { source_data: content.source_data }),
        },
      );

      if (Array.isArray(content.source_data?.tags)) {
        await tagService.tagEntities(
          {
            userId: JOHN_SMITH.id,
          },
          {
            labels: content.source_data.tags.map((tag) => String(tag)),
            entities: [
              {
                type: 'content',
                id: content.id,
              },
            ],
          },
        );
      }
    }

    bar.increment();
  }

  bar.stop();
}
