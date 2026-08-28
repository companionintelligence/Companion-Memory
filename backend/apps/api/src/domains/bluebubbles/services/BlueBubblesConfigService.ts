import crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { BlueBubblesConnectionStatus } from '../entities/BlueBubblesConfigEntity';
import { BlueBubblesConfigEntity } from '../entities/BlueBubblesConfigEntity';

export interface BlueBubblesConfigUpdate {
  host: string;
  port: number;
  useHttps: boolean;
  /** Omitted (undefined) keeps the existing stored password unchanged. */
  password?: string;
  hasPrivateApi: boolean;
  enabled: boolean;
}

/**
 * The single global BlueBubbles config row — appliance-wide, like the Ollama
 * endpoint config, because there is one configured BlueBubbles server per
 * appliance, not one per user.
 *
 * "Single row" is enforced here, not by a database constraint:
 * {@link getOrCreate} is the one choke point every caller (the settings
 * controller, the sync cron, the webhook controller) reads through, and it
 * only ever inserts when the table is genuinely empty.
 */
@Injectable()
export class BlueBubblesConfigService {
  constructor(
    @InjectRepository(BlueBubblesConfigEntity)
    private readonly repo: Repository<BlueBubblesConfigEntity>,
  ) {}

  /**
   * The single config row, minting it — with a fresh, unguessable
   * `webhook_secret` — on first touch. The minted row is inert (`enabled:
   * false`, blank host/port/password) until a caller updates it via
   * {@link update}, so a cron tick or an unauthenticated webhook probe before
   * anyone has configured BlueBubbles can safely call this too.
   */
  async getOrCreate(): Promise<BlueBubblesConfigEntity> {
    const existing = await this.repo.find({ order: { createdAt: 'ASC' }, take: 1 });

    if (existing.length > 0) {
      return existing[0];
    }

    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const rows = await this.repo.manager.query<Array<{ id: string }>>(
      `INSERT INTO ci.bluebubbles_config (host, port, password, webhook_secret)
            VALUES ('', 0, '', $1)
         RETURNING id`,
      [webhookSecret],
    );

    return this.repo.findOneOrFail({ where: { id: rows[0].id } });
  }

  async update(input: BlueBubblesConfigUpdate): Promise<BlueBubblesConfigEntity> {
    const existing = await this.getOrCreate();

    await this.repo.manager.query(
      `UPDATE ci.bluebubbles_config
          SET host = $2, port = $3, use_https = $4,
              password = COALESCE($5, password),
              has_private_api = $6, enabled = $7, updated_at = now()
        WHERE id = $1`,
      [
        existing.id,
        input.host,
        input.port,
        input.useHttps,
        input.password ?? null,
        input.hasPrivateApi,
        input.enabled,
      ],
    );

    return this.repo.findOneOrFail({ where: { id: existing.id } });
  }

  async recordConnectionResult(
    id: string,
    status: BlueBubblesConnectionStatus,
    error: string | null,
  ): Promise<void> {
    await this.repo.manager.query(
      `UPDATE ci.bluebubbles_config
          SET connection_status = $2, last_error = $3, updated_at = now()
        WHERE id = $1`,
      [id, status, error],
    );
  }

  /**
   * Bump `last_sync_cursor`, never rewind it. A bulk sync pass
   * (`BlueBubblesSyncService.runSync`) always advances — its own MAX() query
   * over the run it just staged cannot go backwards — but a single
   * webhook-delivered message can arrive out of order relative to the cursor
   * a concurrent/prior sync already set —
   * `GREATEST` makes that a harmless no-op instead of a rewind that would
   * make the next backstop poll re-fetch everything since.
   */
  async recordSyncCursor(id: string, cursor: Date): Promise<void> {
    await this.repo.manager.query(
      `UPDATE ci.bluebubbles_config
          SET last_sync_cursor = GREATEST(COALESCE(last_sync_cursor, $2), $2), updated_at = now()
        WHERE id = $1`,
      [id, cursor],
    );
  }

  async recordWebhookReceived(id: string): Promise<void> {
    await this.repo.manager.query(
      `UPDATE ci.bluebubbles_config SET last_webhook_received_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  /**
   * Constant-time comparison of a caller-supplied webhook path segment against
   * the stored secret. Both sides are hashed to a fixed 32-byte digest first —
   * `crypto.timingSafeEqual` throws on a length mismatch, and the candidate
   * comes straight off the URL, so its length is attacker-controlled.
   */
  static secretsMatch(candidate: string, stored: string): boolean {
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(stored).digest();

    return crypto.timingSafeEqual(a, b);
  }
}
