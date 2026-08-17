import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { UserCreatedEvent, type UserCreatedPayload } from '@ci/domains/user/events';

import { SavedSearchService } from '../services/SavedSearchService';

/**
 * Seeds the starter saved-search library as soon as a user row exists, so a
 * fresh Memory already has the catalog before the first visit to Saved Searches.
 * `ensureDefaults` is idempotent — first-visit listing and `make seed` can call
 * it again without duplicating.
 */
@Injectable()
export class SeedDefaultSavedSearchesListener {
  constructor(
    private readonly savedSearchService: SavedSearchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SeedDefaultSavedSearchesListener.name);
  }

  @OnEvent(UserCreatedEvent)
  async seedForNewUser(payload: UserCreatedPayload): Promise<void> {
    const created = await this.savedSearchService.ensureDefaults(
      toServiceContext({ userId: payload.userId }),
    );

    if (created) {
      this.logger.log('Seeded default saved searches for new user', { userId: payload.userId });
    }
  }
}
