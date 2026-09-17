import { Injectable } from '@nestjs/common';
import webpush from 'web-push';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { WebPushSubscriptionKeys } from '../entities/PushSubscriptionEntity';

/**
 * The Push API's own de-duplication key. A repeat delivery for the same
 * reminder collapses into one OS notification instead of stacking — the
 * client's service worker passes this straight through to
 * `ServiceWorkerRegistration.showNotification`'s `tag` option.
 */
export function reminderPushTag(reminderId: string): string {
  return `reminder:${reminderId}`;
}

export interface ReminderPushPayload {
  title: string;
  body: string;
  /** Always `/` for now — no deep link to the specific task/block yet. */
  url: string;
  tag: string;
}

export type SendResult = 'ok' | 'gone' | 'fail';

/**
 * Thin wrapper over the `web-push` library — mirrors CI-Planning's
 * `server/src/lib/push.ts` function-for-function. Deliberately knows nothing
 * about `ci.push_subscriptions`: the caller (`ReminderDispatchService`) is
 * what turns a `'gone'` result into a DELETE, exactly as CI-Planning's
 * `deliver()` does, so this class stays a pure transport that is easy to
 * keep in step with the upstream library's own error shape.
 */
@Injectable()
export class WebPushService {
  private configured = false;

  private attempted = false;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(WebPushService.name);
  }

  /**
   * Whether push can be attempted at all — both VAPID keys present. Used by
   * the resolver's `pushPublicKey` query to decide whether to show a
   * "turn on push" control at all; an empty key means the client should not
   * even try `PushManager.subscribe`.
   */
  isConfigured(): boolean {
    return Boolean(config.push.vapid.publicKey && config.push.vapid.privateKey);
  }

  vapidPublicKey(): string | null {
    return this.isConfigured() ? config.push.vapid.publicKey : null;
  }

  /**
   * Lazily calls `webpush.setVapidDetails` exactly once. Returns whether push
   * is usable — mirrors CI-Planning's `ensureConfigured()`, including its
   * refusal to proceed on a half-set pair (an operator supplied one env var
   * and not the other): generating nothing over a deliberate-but-incomplete
   * setup would silently discard whichever half they did set, so this leaves
   * push dormant and logs once instead.
   */
  private ensureConfigured(): boolean {
    if (this.attempted) {
      return this.configured;
    }

    this.attempted = true;

    const { publicKey, privateKey, subject } = config.push.vapid;
    const hasPublic = Boolean(publicKey);
    const hasPrivate = Boolean(privateKey);

    if (hasPublic !== hasPrivate) {
      this.logger.warn(
        'Exactly one of VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY is set — refusing to enable push with a ' +
          'half-configured keypair. Set both, or neither.',
      );

      return false;
    }

    if (!hasPublic || !hasPrivate) {
      return false;
    }

    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.configured = true;

    return true;
  }

  /**
   * `'ok'` on success, `'gone'` when the push service says this subscription
   * no longer exists (404/410 — standard Web Push contract: the browser
   * unsubscribed, was uninstalled, or the endpoint expired), `'fail'` for
   * anything else (push disabled, network error, malformed payload, a 5xx
   * from the push service). Never throws — every branch is caught and
   * logged, matching CI-Planning's `sendPush`.
   */
  async sendPush(subscription: WebPushSubscriptionKeys, payload: ReminderPushPayload): Promise<SendResult> {
    if (!this.ensureConfigured()) {
      return 'fail';
    }

    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));

      return 'ok';
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;

      if (statusCode === 404 || statusCode === 410) {
        return 'gone';
      }

      this.logger.warn('Web push send failed', {
        statusCode,
        error: err instanceof Error ? err.message : String(err),
      });

      return 'fail';
    }
  }
}
