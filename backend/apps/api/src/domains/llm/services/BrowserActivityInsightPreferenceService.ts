import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { PersonService, UserContextService } from '@ci/domains/memory';

/**
 * Settings → Model "Categorize browsing activity". Stored on the self
 * person's `properties.planner.browser_activity_insight_enabled` (default
 * false), same leaf-per-flag shape as {@link ImageDescriptionPreferenceService}.
 *
 * Off by default: this runs on every page visit, a much higher volume than
 * image description, so an operator opts in deliberately rather than a
 * text-only model getting flooded with classification calls it never asked
 * to serve. Unlike image description, enabling this never kicks off a
 * backfill — existing NULL rows are left alone by design.
 */
@Injectable()
export class BrowserActivityInsightPreferenceService {
  private readonly cache = new Map<string, { enabled: boolean; expiresAt: number }>();

  constructor(
    private readonly personService: PersonService,
    private readonly userContextService: UserContextService,
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

    await this.personService.patchPropertyLeaves(context, self.id, [
      { path: ['planner', 'browser_activity_insight_enabled'], value: enabled },
      { path: ['planner', 'source'], value: 'settings' },
    ]);

    this.invalidate(userId);

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

    return planner.browser_activity_insight_enabled === true;
  }
}
