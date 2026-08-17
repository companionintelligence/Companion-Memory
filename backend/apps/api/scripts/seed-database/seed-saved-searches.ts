import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { SavedSearchService } from '@ci/domains/files';

import { JOHN_SMITH } from './data/users';

/**
 * Same catalog and idempotent insert as a live user (UserCreatedEvent + first
 * visit to Saved Searches). John Smith gets the defaults here so `make seed`
 * does not depend on the event listener firing inside the admin testing module.
 */
export async function seedSavedSearches(module: TestingModule, multibar: MultiBar) {
  const savedSearchService = module.get(SavedSearchService);
  const bar = multibar.create(1, 0, { task: 'Saved searches' });

  await savedSearchService.ensureDefaults({ userId: JOHN_SMITH.id });

  bar.increment();
  bar.stop();
}
