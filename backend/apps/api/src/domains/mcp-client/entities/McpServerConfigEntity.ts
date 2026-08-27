import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { buildToolApprovals } from '../services/mcpToolDigest';
import type {
  McpApprovedTool,
  McpAuthConfig,
  McpConfigSource,
  McpConnectionStatus,
  McpDiscoveredTool,
  McpEgressAuthConfig,
  McpEgressSecretEntry,
  McpSecretEntry,
  McpServerConfigEgress,
  McpTransport,
} from '../types';

/**
 * Mirrors migration `20260825233943_create_mcp_server_configs.sql` — the migration is the source
 * of truth (hand-written SQL, dbmate-applied); this entity is kept in sync manually.
 */
@Entity({ schema: 'ci', name: 'mcp_server_configs' })
@Index('mcp_server_configs_user_enabled_idx', ['userId', 'enabled'])
export class McpServerConfigEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  slug!: string;

  @Column({ type: 'text' })
  transport!: McpTransport;

  @Column({ type: 'text', nullable: true })
  command!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  args!: string[];

  /** Per-field-encrypted — see {@link McpSecretCodec}. Never decrypted outside McpClientManagerService. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  env!: McpSecretEntry[];

  @Column({ type: 'text', nullable: true })
  url!: string | null;

  /** Per-field-encrypted — see {@link McpSecretCodec}. */
  @Column({ type: 'jsonb', nullable: true })
  auth!: McpAuthConfig | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'text', default: 'user_added' })
  source!: McpConfigSource;

  @Column({ type: 'text', name: 'catalog_slug', nullable: true })
  catalogSlug!: string | null;

  @Column({ type: 'jsonb', name: 'discovered_tools', nullable: true })
  discoveredTools!: McpDiscoveredTool[] | null;

  /**
   * The human-approved subset — the grant {@link McpToolProvider} intersects `discoveredTools`
   * against. `null` is a pre-approval-gate row (legacy passthrough until its next connect
   * grandfathers it); `[]` is gated with nothing approved. See
   * `20260826205522_add_approved_tools_to_mcp_server_configs.sql`.
   */
  @Column({ type: 'jsonb', name: 'approved_tools', nullable: true })
  approvedTools!: McpApprovedTool[] | null;

  @Column({ type: 'text', name: 'connection_status', default: 'disconnected' })
  connectionStatus!: McpConnectionStatus;

  @Column({ type: 'timestamptz', name: 'last_connected_at', nullable: true })
  lastConnectedAt!: Date | null;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  /**
   * Mask every `secret: true` entry in `env`/`auth.fields` to `{ value: null, isSet: true }` —
   * never ciphertext, never plaintext. Applied on every GET/list/create/update response.
   */
  static toEgressType(entity: McpServerConfigEntity): McpServerConfigEgress {
    return {
      id: entity.id,
      userId: entity.userId,
      name: entity.name,
      slug: entity.slug,
      transport: entity.transport,
      command: entity.command,
      args: entity.args ?? [],
      env: maskEntries(entity.env ?? []),
      url: entity.url,
      auth: entity.auth ? maskAuth(entity.auth) : null,
      enabled: entity.enabled,
      source: entity.source,
      catalogSlug: entity.catalogSlug,
      discoveredTools: entity.discoveredTools,
      approvedTools: entity.approvedTools ?? null,
      // Derived here rather than in the client so the sha256 canonicalisation has exactly one
      // implementation — a second one in the browser would silently disagree on key order.
      toolApprovals: buildToolApprovals(entity.discoveredTools, entity.approvedTools),
      connectionStatus: entity.connectionStatus,
      lastConnectedAt: entity.lastConnectedAt,
      lastError: entity.lastError,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

function maskEntries(entries: McpSecretEntry[]): McpEgressSecretEntry[] {
  return entries.map((entry) =>
    entry.secret
      ? { key: entry.key, label: entry.label, secret: true, value: null, isSet: entry.value != null }
      : { key: entry.key, label: entry.label, secret: false, value: entry.value },
  );
}

function maskAuth(auth: McpAuthConfig): McpEgressAuthConfig {
  return { type: auth.type, fields: maskEntries(auth.fields ?? []) };
}
