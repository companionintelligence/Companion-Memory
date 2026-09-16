import { BadRequestException, ForbiddenException, UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { PushSubscriptionService, ReminderService, WebPushService } from '@ci/domains/planning';

import { CreateReminderInput } from '../types/CreateReminderInput';
import { CreateReminderPayload } from '../types/CreateReminderPayload';
import { GlobalUID } from '../types/GlobalUID';
import { PushSubscriptionInput } from '../types/PushSubscriptionInput';
import { ReminderType } from '../types/ReminderType';

/**
 * Manual reminder CRUD, plus the browser Web Push subscribe/unsubscribe
 * surface. Follows `TaskResolver`'s conventions exactly (same guard, same
 * `planning.enabled` gate, same field validation restated in front of the
 * DB's own CHECKs) since Reminders is part of the planning domain and that
 * domain is GraphQL-only — there are no planning REST controllers.
 *
 * No `node(id)` case is registered for `reminder` (see `NodeResolver`) —
 * `TaskPendingChangeType` sets the precedent that implementing `Node` does
 * not require it, and nothing yet needs `node(<reminder gid>)` resolved.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ReminderType)
export class ReminderResolver {
  constructor(
    private readonly reminderService: ReminderService,
    private readonly pushSubscriptionService: PushSubscriptionService,
    private readonly webPushService: WebPushService,
    private readonly featureService: FeatureService,
  ) {}

  private async assertPlanningEnabled(): Promise<void> {
    if (!(await this.featureService.isFeatureEnabled('planning.enabled'))) {
      throw new ForbiddenException('The planning surface is disabled');
    }
  }

  @Query(() => [ReminderType], { description: 'Reminders not soft-cancelled, ordered by fireAt.' })
  async reminders(@Context() context: RequestContext): Promise<ReminderType[]> {
    if (!(await this.featureService.isFeatureEnabled('planning.enabled'))) {
      return [];
    }

    const serviceContext = toServiceContext(context);
    const rows = await this.reminderService.listForUser(serviceContext);

    return rows.map((row) => ReminderType.toType(row));
  }

  @Query(() => String, {
    nullable: true,
    description: 'The VAPID public key, base64url — null when push is not configured on this appliance.',
  })
  pushPublicKey(): string | null {
    return this.webPushService.vapidPublicKey();
  }

  @Mutation(() => CreateReminderPayload)
  async createReminder(
    @Context() context: RequestContext,
    @Args('input') input: CreateReminderInput,
  ): Promise<CreateReminderPayload> {
    await this.assertPlanningEnabled();

    if (input.fireAt.getTime() <= Date.now()) {
      throw new BadRequestException('`fireAt` must be in the future');
    }

    const serviceContext = toServiceContext(context);
    const reminder = await this.reminderService.create(serviceContext, {
      taskId: input.taskId ? GlobalUID.parse('task', input.taskId) : null,
      blockId: input.blockId ? GlobalUID.parse('event', input.blockId) : null,
      fireAt: input.fireAt,
    });

    return { success: true, reminder: ReminderType.toType(reminder) };
  }

  @Mutation(() => ReminderType, { nullable: true, description: 'Soft-cancel a reminder. The row survives.' })
  async cancelReminder(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ReminderType | null> {
    if (!(await this.featureService.isFeatureEnabled('planning.enabled'))) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const reminder = await this.reminderService.cancel(serviceContext, GlobalUID.parse('reminder', gid));

    return reminder ? ReminderType.toType(reminder) : null;
  }

  @Mutation(() => Boolean, { description: 'Register (or re-point) a browser Web Push endpoint.' })
  async subscribeToPush(
    @Context() context: RequestContext,
    @Args('input') input: PushSubscriptionInput,
  ): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    await this.pushSubscriptionService.subscribe(serviceContext, {
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent,
    });

    return true;
  }

  @Mutation(() => Boolean, { description: 'Remove a browser Web Push endpoint.' })
  async unsubscribeFromPush(
    @Context() context: RequestContext,
    @Args('endpoint') endpoint: string,
  ): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    return this.pushSubscriptionService.unsubscribe(serviceContext, endpoint);
  }
}
