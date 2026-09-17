import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';

import { PushSubscriptionEntity, type PushSubscription } from '../entities/PushSubscriptionEntity';

export interface SubscribePushDto {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/**
 * Browser Web Push subscription registry. Mirrors CI-Planning's
 * `subscribePushChecked`/`unsubscribePush` (`services/notifications.ts`).
 *
 * `endpoint` is globally unique (minted by the Push API), not per-user — so
 * `subscribe` is an upsert keyed on it, same "newest subscriber owns this
 * browser slot" policy CI-Planning ships: re-subscribing an already-
 * registered endpoint under a different user re-points it rather than
 * erroring. That is the right call for a shared/kiosk browser and is not
 * something this milestone should tighten without a product decision.
 */
@Injectable()
export class PushSubscriptionService {
  constructor(
    @InjectRepository(PushSubscriptionEntity)
    private readonly repository: Repository<PushSubscriptionEntity>,
  ) {}

  async subscribe(context: UserServiceContext, dto: SubscribePushDto): Promise<PushSubscription> {
    const existing = await this.repository.findOne({ where: { endpoint: dto.endpoint } });

    if (existing) {
      existing.userId = context.userId;
      existing.p256dh = dto.p256dh;
      existing.auth = dto.auth;
      existing.userAgent = dto.userAgent ?? null;

      return this.repository.save(existing);
    }

    const entity = this.repository.create({
      id: uuidv7(),
      userId: context.userId,
      endpoint: dto.endpoint,
      p256dh: dto.p256dh,
      auth: dto.auth,
      userAgent: dto.userAgent ?? null,
    });

    return this.repository.save(entity);
  }

  /** Owner-scoped: a caller can only ever remove their own subscription. */
  async unsubscribe(context: UserServiceContext, endpoint: string): Promise<boolean> {
    const result = await this.repository.delete({ endpoint, userId: context.userId });

    return (result.affected ?? 0) > 0;
  }

  async listForUser(userId: string): Promise<PushSubscription[]> {
    return this.repository.find({ where: { userId } });
  }

  /** Used by `ReminderDispatchService` when a push send reports `'gone'`. */
  async remove(id: string): Promise<void> {
    await this.repository.delete({ id });
  }
}
