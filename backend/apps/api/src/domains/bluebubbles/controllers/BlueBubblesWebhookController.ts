import { Body, Controller, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod/v3';

import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import type { BlueBubblesMessage } from '@ci/domains/import';

import { BlueBubblesConfigService } from '../services/BlueBubblesConfigService';
import { BlueBubblesSyncService } from '../services/BlueBubblesSyncService';

/**
 * BlueBubbles webhook event types this controller cares about. BlueBubbles
 * fires several others (`chat-read-status-changed`, `typing-indicator`,
 * `hello-world`, `server-update`, `message-send-error`, …) — every one of
 * them still gets a 200 (BlueBubbles has no interest in, or retry policy
 * around, a webhook body), just no ingestion work.
 */
const INGESTABLE_TYPES = new Set(['new-message', 'updated-message']);

// Deliberately loose: this is a third-party server's webhook body, and the
// downstream mapper (`mapBlueBubblesMessageToGraph`) already tolerates
// missing/null fields the same way the bulk importer does. Validating here
// would just be a second, competing opinion about BlueBubbles' own schema.
const webhookBodySchema = z.object({
  type: z.string(),
  data: z.unknown().optional(),
});

/**
 * `POST /api/bluebubbles/webhook/:secret` — where a configured BlueBubbles
 * server pushes live messages.
 *
 * Auth is the path segment itself: BlueBubbles' outgoing webhooks carry no
 * header/bearer auth of their own, so the unguessable `:secret` (minted at
 * config-row creation, see `BlueBubblesConfigEntity.webhookSecret`) IS the
 * credential. A mismatch returns a generic 404 rather than 401 — a 401 would
 * confirm to anyone probing the path that a BlueBubbles integration exists
 * here at all, which a 404 does not.
 */
@Controller('bluebubbles/webhook')
export class BlueBubblesWebhookController {
  constructor(
    private readonly configService: BlueBubblesConfigService,
    private readonly syncService: BlueBubblesSyncService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BlueBubblesWebhookController.name);
  }

  @Post(':secret')
  @HttpCode(200)
  async handle(
    @Param('secret') secret: string,
    @Body(new ValidationPipe(webhookBodySchema)) body: z.infer<typeof webhookBodySchema>,
  ): Promise<{ ok: true }> {
    // `find`, not `getOrCreate`: this route is UNAUTHENTICATED until the
    // comparison below succeeds, so it must not be able to write anything.
    // Minting the row here let an outsider probing the path create it — and the
    // creation is what mints the webhook secret, so a probe that raced a
    // legitimate first save could decide which secret the appliance ends up
    // with. No row at all is answered exactly like a wrong secret.
    const config = await this.configService.find();

    // `timingSafeEqual` throws on mismatched buffer lengths rather than
    // returning false, and `secret` comes straight off the URL — an
    // attacker-controlled length. `secretsMatch` hashes both sides to a fixed
    // digest first specifically so this compare is safe to call with an
    // arbitrary path segment.
    if (config == null || !BlueBubblesConfigService.secretsMatch(secret, config.webhookSecret)) {
      throw new NotFoundException();
    }

    // Switched off means off: answered like a wrong secret, and nothing is
    // recorded. The delivery used to be accepted and stamped
    // `last_webhook_received_at`, which every account's Services card reads as
    // activity, so one stray delivery turned BlueBubbles "In use · synced
    // today" on an appliance where it was turned off. Messages were already
    // dropped on this path (`ingestWebhookMessage` checks the same flag).
    if (!config.enabled) {
      throw new NotFoundException();
    }

    await this.configService.recordWebhookReceived(config.id);

    if (INGESTABLE_TYPES.has(body.type) && body.data) {
      try {
        await this.syncService.ingestWebhookMessage(body.data as BlueBubblesMessage);
      } catch (err) {
        // This awaits only the QUEUEING of the message — the run that ingests it
        // is a coalesced flush a couple of seconds later (see
        // BlueBubblesSyncService), which reports its own failures onto the run
        // and the config row. So the only thing that reaches here is a failure
        // to accept the delivery at all, and even that must not make BlueBubbles
        // think the endpoint is down and start retrying/backing off: the
        // backstop cron picks up whatever a delivery failed to land.
        this.logger.error(
          'BlueBubbles webhook: failed to ingest message',
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    return { ok: true };
  }
}
