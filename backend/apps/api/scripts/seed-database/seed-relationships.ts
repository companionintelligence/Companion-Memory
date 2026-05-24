import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { RelationshipService } from '@ci/domains/graph';

import { RELATIONSHIPS } from './data/relationships';
import { JOHN_SMITH } from './data/users';

export async function seedRelationships(module: TestingModule, multibar: MultiBar) {
  const relationshipService = module.get(RelationshipService);

  const bar = multibar.create(RELATIONSHIPS.length, 0, { task: 'Relationships' });

  for (const relationship of RELATIONSHIPS) {
    await relationshipService.create(
      {
        userId: JOHN_SMITH.id,
      },
      relationship,
    );

    bar.increment();
  }

  bar.stop();
}
