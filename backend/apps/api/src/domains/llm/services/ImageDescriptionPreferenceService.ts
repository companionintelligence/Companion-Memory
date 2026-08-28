import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';
import { ImageDescriptionBackfillRequestEvent } from '@ci/domains/files';
import { PersonService, UserContextService } from '@ci/domains/memory';

/**
 * Settings → Model "Describe images". Stored on the self person's
 * `properties.planner.image_description_enabled` (default false).
 *
 * Lives in its own module so vision listeners can gate without importing
 * PersonalizationModule (which already depends on LlmCore → cycle).
 */
@Injectable()
export class ImageDescriptionPreferenceService {
  private readonly cache = new Map<string, { enabled: boolean; expiresAt: number }>();

  constructor(
    private readonly personService: PersonService,
    private readonly userContextService: UserContextService,
    private readonly eventService: EventService,
  ) {}

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  async isEnabled(userId: string): Promise<boolean> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.enabled;
    }

    const enabled = await this.readEnabled(userId);
    this.cache.set(userId, { enabled, expiresAt: Date.now() + 60_000 });

    return enabled;
  }

  async setEnabled(context: UserServiceContext, enabled: boolean): Promise<boolean> {
    const userId = context.userId!;
    const selfIdentity = await this.userContextService.getSelfIdentity(userId);

    if (!selfIdentity) {
      throw new Error('Self entity not found');
    }

    const self = await this.personService.findById(context, selfIdentity.entityId);

    if (!self) {
      throw new Error('Self entity not found');
    }

    const priorPlanner = (self.properties?.planner as Record<string, unknown> | undefined) ?? {};
    // Only used to decide whether to kick off a backfill — never sent back as a
    // write payload. Re-sending the whole `planner` sub-object would resurrect
    // the stale `trust_mode` we read before another writer changed it.
    const wasEnabled = priorPlanner.image_description_enabled === true;

    await this.personService.patchPropertyLeaves(context, self.id, [
      { path: ['planner', 'image_description_enabled'], value: enabled },
      { path: ['planner', 'source'], value: 'settings' },
    ]);

    this.invalidate(userId);

    if (enabled && !wasEnabled) {
      await this.eventService.send(
        ImageDescriptionBackfillRequestEvent,
        { userId },
        { singletonKey: `image-description-backfill:${userId}` },
      );
    }

    return enabled;
  }

  private async readEnabled(userId: string): Promise<boolean> {
    const selfIdentity = await this.userContextService.getSelfIdentity(userId);

    if (!selfIdentity) {
      return false;
    }

    const context = { userId } as UserServiceContext;
    const self = await this.personService.findById(context, selfIdentity.entityId);
    const planner = (self?.properties?.planner ?? {}) as Record<string, unknown>;

    return planner.image_description_enabled === true;
  }
}
