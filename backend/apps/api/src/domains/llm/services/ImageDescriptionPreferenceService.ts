import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { type UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';
import { ImageDescriptionBackfillRequestEvent } from '@ci/domains/files';
import { PersonService, UserContextService, ensureSelfEntityId } from '@ci/domains/memory';

import { OllamaService } from './OllamaService';

/**
 * Settings → Model "Describe images".
 *
 * Defaults to whatever {@link OllamaService.resolveVisionModel} says the
 * user's vision work actually runs on: on when that model reports the
 * `vision` capability, off when it does not — re-evaluated on every call, so
 * switching chat models (or an operator setting/clearing the utility model)
 * changes the default immediately, with nothing to migrate. A user can still
 * override the default for the CURRENT model specifically
 * (`properties.planner.image_description_overrides.<model>`); switching to a
 * different model evaluates that model's own default and its own override,
 * never inheriting the one that was set for a different model.
 *
 * Before this, the setting was a single unconditional boolean
 * (`image_description_enabled`, default false) an operator had to remember to
 * turn on — which is exactly why the images in the first library imported on
 * this appliance carry no description at all.
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
    private readonly ollamaService: OllamaService,
    /**
     * For `SELF_ENTITY_PROVISIONER`, resolved lazily by `ensureSelfEntityId`.
     * Optional so a hand-built service (the unit tests) still constructs; without
     * it a user who has no self entity gets the old error rather than a new one.
     */
    @Optional() private readonly moduleRef?: ModuleRef,
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

  /**
   * Sets (or clears, passing `enabled: null`) the explicit override for
   * whichever model {@link OllamaService.resolveVisionModel} currently
   * resolves to. Firing the one-time backfill on a false→true transition is
   * unchanged from before this setting became per-model.
   */
  async setEnabled(context: UserServiceContext, enabled: boolean | null): Promise<boolean> {
    const userId = context.userId!;
    // Read BEFORE the self entity is provisioned. A user with none reads as "off"
    // (`readEnabled` finds no identity), so the first time they turn this on for a
    // vision model is a genuine off→on transition and must fire the backfill; read
    // afterwards it would already show the model's automatic default, and the
    // transition — and the descriptions of every image already imported — would
    // be lost.
    const wasEnabled = await this.readEnabled(userId);
    // Provisioned when the user has none: an imported account has no self entity
    // to store the override on, and this write answered 500 for it.
    const selfEntityId = await ensureSelfEntityId(context, this.userContextService, this.moduleRef);
    const { model } = await this.ollamaService.resolveVisionModel(userId);

    // A true leaf write — `image_description_overrides.<model>`, not the
    // container object — so a concurrent write to a DIFFERENT model's
    // override (or to `chat_model`, `trust_mode`, anything else in `planner`)
    // cannot be clobbered by this one; see jsonbLeafPatch.ts. Model ids can
    // contain `.`/`:` (`qwen3.6:27b`) — safe here because the path travels as
    // a parameterised `text[]`, never interpolated into the path string.
    // `enabled: null` clears the override (readEnabled treats a non-boolean
    // stored value as "automatic"); jsonb_set cannot delete the key, but a
    // stored JSON null reads back as exactly that.
    await this.personService.patchPropertyLeaves(context, selfEntityId, [
      { path: ['planner', 'image_description_overrides', model], value: enabled },
      { path: ['planner', 'source'], value: 'settings' },
    ]);

    this.invalidate(userId);

    const resolvedEnabled = await this.readEnabled(userId);

    if (resolvedEnabled && !wasEnabled) {
      await this.eventService.send(
        ImageDescriptionBackfillRequestEvent,
        { userId },
        { singletonKey: `image-description-backfill:${userId}` },
      );
    }

    return resolvedEnabled;
  }

  private async readEnabled(userId: string): Promise<boolean> {
    const selfIdentity = await this.userContextService.getSelfIdentity(userId);

    if (!selfIdentity) {
      return false;
    }

    const context = { userId } as UserServiceContext;
    const [self, { model, supportsVision }] = await Promise.all([
      this.personService.findById(context, selfIdentity.entityId),
      this.ollamaService.resolveVisionModel(userId),
    ]);
    const planner = (self?.properties?.planner ?? {}) as Record<string, unknown>;
    const overrides = (planner.image_description_overrides as Record<string, unknown> | undefined) ?? {};
    const override = overrides[model];

    return typeof override === 'boolean' ? override : supportsVision;
  }
}
