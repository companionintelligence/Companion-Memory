import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Rollup of the last attempt to reach the configured BlueBubbles server. */
export type BlueBubblesConnectionStatus = 'connected' | 'error' | 'unknown';

/**
 * Appliance-wide BlueBubbles (https://github.com/BlueBubblesApp/bluebubbles-app)
 * connection config: a single global row, like the Ollama endpoint config —
 * there is one BlueBubbles server per appliance, not one per user. Mirrors
 * migration 20260825233552_create_bluebubbles_config.
 *
 * "Single row" is enforced in {@link BlueBubblesConfigService.getOrCreate},
 * not by a database constraint — the same shape the LLM endpoint config uses,
 * just backed by a table instead of a file because this config also carries
 * mutable sync/connection state (`lastSyncCursor`, `connectionStatus`) that a
 * plain settings file has no good place for.
 */
@Entity({ schema: 'ci', name: 'bluebubbles_config' })
export class BlueBubblesConfigEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  host!: string;

  @Column({ type: 'integer' })
  port!: number;

  @Column({ type: 'boolean', name: 'use_https', default: false })
  useHttps!: boolean;

  /**
   * BlueBubbles' own server password — a full-control credential for the
   * configured Mac. Stored in plaintext, consistent with this codebase's
   * existing precedent for single-appliance service credentials (e.g. the LLM
   * endpoint's apiKey column); never returned to a client, see
   * BlueBubblesConfigController's masked GET response.
   */
  @Column({ type: 'text' })
  password!: string;

  @Column({ type: 'boolean', name: 'has_private_api', default: false })
  hasPrivateApi!: boolean;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  /**
   * Random per-row token minted at row creation (crypto.randomBytes(32).toString('hex'))
   * that forms an unguessable webhook URL path segment
   * (`POST /api/bluebubbles/webhook/:secret`) — BlueBubbles has no header-auth
   * story for its outgoing webhooks, so the secret itself IS the auth.
   */
  @Column({ type: 'text', name: 'webhook_secret' })
  webhookSecret!: string;

  /**
   * High-water mark the next BACKFILL sync resumes from — the newest message a
   * completed pass actually pushed into `ci.*`.
   *
   * Deliberately NOT touched by live webhook deliveries. A single new text
   * arriving before the backfill has caught up would otherwise set this to
   * "now", and the entire history behind it would be skipped forever under a
   * `completed` run with no error. Live arrivals are recorded by
   * {@link BlueBubblesConfigEntity.lastWebhookReceivedAt} instead, which is a
   * fact about the webhook rather than a resume point for the backfill.
   */
  @Column({ type: 'timestamptz', name: 'last_sync_cursor', nullable: true })
  lastSyncCursor!: Date | null;

  @Column({ type: 'timestamptz', name: 'last_webhook_received_at', nullable: true })
  lastWebhookReceivedAt!: Date | null;

  /**
   * The pass currently syncing, or null — the appliance-wide claim that makes
   * "one sync at a time" true across the api and worker processes. See
   * migration 20260901205239_bluebubbles_sync_claim.
   */
  @Column({ type: 'text', name: 'sync_claim_token', nullable: true })
  syncClaimToken!: string | null;

  /** Last sign of life from the claim holder; silence past the window frees the claim. */
  @Column({ type: 'timestamptz', name: 'sync_heartbeat_at', nullable: true })
  syncHeartbeatAt!: Date | null;

  @Column({ type: 'text', name: 'connection_status', default: 'unknown' })
  connectionStatus!: BlueBubblesConnectionStatus;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

export type BlueBubblesConfig = Readonly<BlueBubblesConfigEntity>;
