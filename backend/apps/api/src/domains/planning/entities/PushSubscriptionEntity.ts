import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A browser Web Push endpoint (`PushSubscription.endpoint` + its ECDH keys),
 * NOT a native APNs/FCM token — see `ci.devices.push_token` /
 * `DeviceService` for that, and the migration's header comment
 * (20260916030813_planning_reminders.sql) for why the two do not share a
 * table.
 *
 * One row per subscribed browser (`endpoint` is globally unique, minted by
 * the Push API — roughly per-device-per-browser-per-origin, not per user).
 * `p256dh`/`auth` are the subscription's public key and auth secret; never
 * expose them outside `WebPushService` — see `ReminderResolver`, which
 * accepts them on subscribe but never reads them back out.
 */
@Entity({ schema: 'ci', name: 'push_subscriptions' })
@Index('idx_push_subscriptions_user', ['userId'])
export class PushSubscriptionEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text' })
  endpoint!: string;

  @Column({ type: 'text' })
  p256dh!: string;

  @Column({ type: 'text' })
  auth!: string;

  @Column({ type: 'text', name: 'user_agent', nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

export type PushSubscription = Readonly<PushSubscriptionEntity>;

/** Shape the `web-push` library's `sendNotification` expects. */
export interface WebPushSubscriptionKeys {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export function toWebPushSubscription(entity: PushSubscriptionEntity): WebPushSubscriptionKeys {
  return {
    endpoint: entity.endpoint,
    keys: { p256dh: entity.p256dh, auth: entity.auth },
  };
}
