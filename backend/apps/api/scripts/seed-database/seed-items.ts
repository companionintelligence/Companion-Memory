import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { ItemService } from '@ci/domains/memory';
import { TagService } from '@ci/domains/search-next';

import { ITEMS } from './data/items';
import { JOHN_SMITH } from './data/users';

export async function seedItems(module: TestingModule, multibar: MultiBar) {
  const itemService = module.get(ItemService);
  const tagService = module.get(TagService);

  const bar = multibar.create(ITEMS.length, 0, { task: 'Items' });

  for (const item of ITEMS) {
    if (item.id == null) {
      bar.increment();

      continue;
    }

    const existingItem = await itemService.findById(
      {
        userId: JOHN_SMITH.id,
      },
      item.id,
    );

    if (existingItem == null) {
      await itemService.create(
        {
          userId: JOHN_SMITH.id,
        },
        {
          id: item.id,
          name: item.name,
          category: item.category,
          ...(item.brand && { brand: item.brand }),
          ...(item.model && { model: item.model }),
          ...(item.metadata && { metadata: item.metadata }),
        },
      );

      if (Array.isArray(item.metadata?.tags)) {
        await tagService.tagEntities(
          {
            userId: JOHN_SMITH.id,
          },
          {
            labels: item.metadata.tags.map((tag) => String(tag)),
            entities: [
              {
                type: 'item',
                id: item.id,
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
