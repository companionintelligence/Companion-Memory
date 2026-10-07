import crypto from 'node:crypto';

import { BadRequestException, Injectable, type OnModuleInit } from '@nestjs/common';
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
 * Whether `next` points the connector at a different server than `saved`.
 *
 * The stored password only ever goes to the server it was saved for: a save or a test that names
 * another address must carry its own. Otherwise anyone allowed to change the address (any
 * administrator, not only the connector's owner) could have the appliance hand the owner's
 * password to a server of their choosing.
 */
export function serverAddressChanges(
  saved: { host: string; port: number; useHttps: boolean },
  next: { host?: string; port?: number; useHttps?: boolean },
): boolean {
  return (
    (next.host !== undefined && next.host !== saved.host) ||
    (next.port !== undefined && next.port !== saved.port) ||
    (next.useHttps !== undefined && next.useHttps !== saved.useHttps)
  );
}

/**
 * How long a sync claim survives without a heartbeat before another pass may
 * take it.
 *
 * A live pass refreshes the claim every {@link SYNC_HEARTBEAT_MS}, so silence
 * for this long means the holder is gone — crashed, killed, or restarted out
 * from under the work. The same reasoning (and roughly the same window) as
 * `ImportRunService`'s `STALE_STAGE_MINUTES`: without it, one killed process
 * owns the connector until somebody edits the table by hand.
 */
export const SYNC_CLAIM_STALE_MINUTES = 15;

/** How often a pass proves it is still alive. Well inside the staleness window. */
export const SYNC_HEARTBEAT_MS = 30_000;

/**
 * The single global BlueBubbles config row — appliance-wide, like the Ollama
 * endpoint config, because there is one configured BlueBubbles server per
 * appliance, not one per user.
 *
 * "Single row" is enforced by `bluebubbles_config_singleton_uq` (migration
 * 20260901205239) as well as by {@link getOrCreate}. The service check alone
 * was a check-then-insert: two callers that missed each other by a millisecond
 * minted two rows with two different webhook secrets, after which which one a
 * caller got was up to the planner and a webhook signed with the loser's secret
 * 404'd forever.
 */
@Injectable()
export class BlueBubblesConfigService implements OnModuleInit {
  /**
   * The connector's owner as of the last time this process read the row, or
   * `undefined` before the first read. See {@link lastKnownOwnerUserId}.
   */
  private knownOwnerUserId: string | null | undefined = undefined;

  constructor(
    @InjectRepository(BlueBubblesConfigEntity)
    private readonly repo: Repository<BlueBubblesConfigEntity>,
  ) {}

  /**
   * Read the row once at boot so {@link lastKnownOwnerUserId} has an answer
   * before the first tool list is built. Best-effort: a database that is not up
   * yet leaves the answer unknown, which hides the messaging tools from
   * everyone until the next read rather than showing them to anyone.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.find();
    } catch {
      // Unknown stays unknown; the next read of the row fills it in.
    }
  }

  /**
   * The connector's owner as this process last saw it, without a query.
   *
   * For the `messaging.*` tools' schemas, which the tool registry reads
   * synchronously to decide who may see and run them. Every read of the row in
   * this process refreshes it (the settings page, a save, each sync tick,
   * each messaging call), so it lags a change made in ANOTHER process by at
   * most one cron tick. The lag can only hide a tool or show it to the previous
   * owner; it cannot run one for the wrong account, because
   * `BlueBubblesClientService` checks the owner against the database on every
   * call.
   */
  lastKnownOwnerUserId(): string | null {
    return this.knownOwnerUserId ?? null;
  }

  private remember<T extends BlueBubblesConfigEntity | null>(row: T): T {
    this.knownOwnerUserId = row?.ownerUserId ?? null;

    return row;
  }

  /**
   * The config row if one exists — never minting it.
   *
   * What an UNAUTHENTICATED caller gets. The webhook controller reads through
   * this rather than {@link getOrCreate} because its own auth check happens
   * after the read: probing a path must not be able to write a row, however
   * inert that row is.
   */
  async find(): Promise<BlueBubblesConfigEntity | null> {
    const [existing] = await this.repo.find({ order: { createdAt: 'ASC' }, take: 1 });

    return this.remember(existing ?? null);
  }

  /**
   * The single config row, minting it — with a fresh, unguessable
   * `webhook_secret` — on first touch. The minted row is inert (`enabled:
   * false`, blank host/port/password) until a caller updates it via
   * {@link update}, so a cron tick before anyone has configured BlueBubbles can
   * safely call this too.
   *
   * `ON CONFLICT DO NOTHING` against the singleton index, then a re-read: the
   * loser of a race gets the winner's row rather than an error, which is the
   * answer every caller of a get-or-create actually wants.
   */
  async getOrCreate(): Promise<BlueBubblesConfigEntity> {
    const existing = await this.find();

    if (existing != null) {
      return existing;
    }

    const webhookSecret = crypto.randomBytes(32).toString('hex');

    await this.repo.manager.query(
      `INSERT INTO ci.bluebubbles_config (host, port, password, webhook_secret)
            VALUES ('', 0, '', $1)
       ON CONFLICT DO NOTHING`,
      [webhookSecret],
    );

    const created = await this.find();

    if (created == null) {
      throw new Error('BlueBubbles config row could not be created');
    }

    return created;
  }

  /**
   * Save the connection settings.
   *
   * `actorUserId` is the administrator saving them. They become the
   * connector's owner when it has none, or when its owner's account no longer
   * exists (soft-deleted, or removed outright and nulled by the foreign key).
   * Otherwise the owner stays as it is: another administrator adjusting the
   * settings, or toggling the connector off, does not take over somebody
   * else's messages. The claim is decided inside the UPDATE so two saves
   * racing on an unowned row cannot both win.
   */
  async update(input: BlueBubblesConfigUpdate, actorUserId: string): Promise<BlueBubblesConfigEntity> {
    const existing = await this.getOrCreate();

    // Refused rather than saved. `enabled` with no password stored is a
    // connector that can never authenticate: every sync pass would fail on the
    // first request, and before this the failure surfaced as an ERROR log every
    // ten minutes forever rather than as anything the person who saved it would
    // see. The password may be omitted (that means "keep the stored one") — it
    // is only missing on BOTH sides that is unsatisfiable.
    if (input.enabled && !input.password && existing.password.length === 0) {
      throw new BadRequestException(
        'A BlueBubbles server password is required before the connection can be enabled.',
      );
    }

    // The stored password is the owner's credential for their Mac. Keeping it while the address
    // changes would have the next sync (and the owner's messaging tools) send it to whatever
    // server the saver named, which is how another administrator could read it.
    if (!input.password && existing.password.length > 0 && serverAddressChanges(existing, input)) {
      throw new BadRequestException(
        'Enter the BlueBubbles server password again to change the server address.',
      );
    }

    await this.repo.manager.query(
      `UPDATE ci.bluebubbles_config c
          SET host = $2, port = $3, use_https = $4,
              password = COALESCE($5, password),
              has_private_api = $6, enabled = $7,
              owner_user_id = CASE
                WHEN c.owner_user_id IS NULL
                  OR NOT EXISTS (SELECT 1 FROM ci.users u
                                  WHERE u.id = c.owner_user_id AND u.deleted_at IS NULL)
                THEN $8::uuid
                ELSE c.owner_user_id
              END,
              updated_at = now()
        WHERE c.id = $1`,
      [
        existing.id,
        input.host,
        input.port,
        input.useHttps,
        input.password ?? null,
        input.hasPrivateApi,
        input.enabled,
        actorUserId,
      ],
    );

    return this.remember(await this.repo.findOneOrFail({ where: { id: existing.id } }));
  }

  /**
   * Replace the webhook secret, which is the only credential on
   * `POST /api/bluebubbles/webhook/:secret`.
   *
   * An administrator action, never automatic: the moment this runs, the URL
   * pasted into BlueBubbles Server stops working until someone pastes the new
   * one, and until then live messages only arrive on the ten-minute backstop
   * poll. That trade is the owner's to make, for instance after the old URL was
   * shown to somebody who should not have it.
   */
  async rotateWebhookSecret(): Promise<BlueBubblesConfigEntity> {
    const existing = await this.getOrCreate();

    await this.repo.manager.query(
      `UPDATE ci.bluebubbles_config SET webhook_secret = $2, updated_at = now() WHERE id = $1`,
      [existing.id, crypto.randomBytes(32).toString('hex')],
    );

    return this.remember(await this.repo.findOneOrFail({ where: { id: existing.id } }));
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
   * Bump the BACKFILL cursor, never rewind it.
   *
   * Called by {@link BlueBubblesSyncService}'s bulk pass ONLY, and only once
   * that pass's rows have actually reached `ci.*`. The webhook path
   * deliberately does not call it at all: `GREATEST` makes the cursor a
   * ratchet, so one live message delivered before the backfill had caught up
   * would pin it at "now" and skip the entire history behind it — permanently,
   * under a `completed` run with no error. A live delivery is recorded as
   * `last_webhook_received_at`, which says what actually happened without
   * claiming anything about how far the backfill has read.
   *
   * `GREATEST` still earns its place between two BULK passes: two overlapping
   * passes (a "Sync now" and a cron tick that took the claim after it) can
   * finish out of order, and the older one's MAX() must not rewind the newer
   * one's.
   */
  async recordSyncCursor(id: string, cursor: Date): Promise<void> {
    await this.repo.manager.query(
      `UPDATE ci.bluebubbles_config
          SET last_sync_cursor = GREATEST(COALESCE(last_sync_cursor, $2), $2), updated_at = now()
        WHERE id = $1`,
      [id, cursor],
    );
  }

  /**
   * Take the appliance-wide sync claim, or report that somebody else holds it.
   *
   * THE concurrency guard, and it has to live in the database because the thing
   * it guards spans processes. `BlueBubblesSyncCron` used a `private running`
   * instance field, which is per-process — and the cron is registered in BOTH
   * the api and the worker, each with its own copy, so every tick started two
   * full passes (a live appliance logged 25 runs in two hours, two per tick).
   * "Sync now" called `runSync()` with no guard at all, so two clicks during a
   * tick made four concurrent full-history passes, all of them pushing into the
   * shared `ci.*` tables at once — the untested dedup path
   * `IMPORT_STAGE_CONCURRENCY.push = 1` exists specifically to prevent.
   *
   * The shape is `ImportRunService.startRun`'s upload claim: a CONSTRAINED
   * UPDATE, so the loser affects no rows and learns it lost rather than
   * trampling a pass in flight. CTE-wrapped so the outer command is a SELECT —
   * TypeORM's Postgres driver resolves a bare `UPDATE ... RETURNING` as
   * `[rows, rowCount]`, whose `length` is always 2, and every caller would
   * "win".
   *
   * The staleness disjunct is what keeps a killed process from owning the
   * connector forever; see {@link SYNC_CLAIM_STALE_MINUTES}.
   */
  async claimSync(id: string, token: string): Promise<boolean> {
    const rows = await this.repo.manager.query<unknown[]>(
      `WITH claimed AS (
         UPDATE ci.bluebubbles_config
            SET sync_claim_token = $2, sync_heartbeat_at = now(), updated_at = now()
          WHERE id = $1
            AND (sync_claim_token IS NULL
                 OR sync_heartbeat_at IS NULL
                 OR sync_heartbeat_at < now() - make_interval(mins => $3::int))
      RETURNING id)
       SELECT id FROM claimed`,
      [id, token, SYNC_CLAIM_STALE_MINUTES],
    );

    return rows.length > 0;
  }

  /**
   * Prove this pass is still alive.
   *
   * Constrained to the caller's own token, so a pass whose claim was already
   * stolen as stale cannot silently take it back and run alongside its thief.
   */
  async heartbeatSync(id: string, token: string): Promise<void> {
    await this.repo.manager.query(
      `UPDATE ci.bluebubbles_config
          SET sync_heartbeat_at = now()
        WHERE id = $1 AND sync_claim_token = $2`,
      [id, token],
    );
  }

  /** Hand the claim back. Token-constrained for the same reason the heartbeat is. */
  async releaseSync(id: string, token: string): Promise<void> {
    await this.repo.manager.query(
      `UPDATE ci.bluebubbles_config
          SET sync_claim_token = NULL, sync_heartbeat_at = NULL, updated_at = now()
        WHERE id = $1 AND sync_claim_token = $2`,
      [id, token],
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
