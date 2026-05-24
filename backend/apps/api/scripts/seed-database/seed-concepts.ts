import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { ConceptService } from '@ci/domains/memory';

import { CONCEPTS } from './data/concepts';
import { JOHN_SMITH } from './data/users';

export async function seedConcepts(module: TestingModule, multibar: MultiBar) {
  const conceptService = module.get(ConceptService);

  const bar = multibar.create(CONCEPTS.length, 0, { task: 'Concepts' });

  for (const concept of CONCEPTS) {
    const existingConcept = await conceptService.findById(
      {
        userId: JOHN_SMITH.id,
      },
      concept.id,
    );

    if (existingConcept == null) {
      await conceptService.create(
        {
          userId: JOHN_SMITH.id,
        },
        {
          id: concept.id,
          name: concept.name,
          description: concept.description,
          ...(concept.properties && { properties: concept.properties }),
        },
      );
    }

    bar.increment();
  }

  bar.stop();
}
