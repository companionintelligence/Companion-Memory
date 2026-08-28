/**
 * Shared shapes for the MCP-client domain: user-configured connections to external Model Context
 * Protocol servers, treated as a second tool provider alongside CI-Server's native one.
 */

export type McpTransport = 'stdio' | 'http';

export type McpConfigSource = 'user_added' | 'catalog';

export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * One key/value entry in an `env[]` array or an `auth.fields[]` array. The same shape backs both,
 * so {@link McpSecretCodec} walks a single generic list rather than two bespoke ones.
 *
 * `secret: true` means `value` is encrypted at rest (`McpSecretCodec.encryptEntries`) and MUST be
 * masked to `{ value: null, isSet: true }` on every egress path — see {@link McpEgressSecretEntry}.
 */
export interface McpSecretEntry {
  key: string;
  value: string | null;
  secret: boolean;
  label?: string;
}

/** {@link McpSecretEntry} as returned to a client: a secret entry's real value is never sent back. */
export interface McpEgressSecretEntry {
  key: string;
  value: string | null;
  secret: boolean;
  label?: string;
  /** Present (and `true`) only on a masked secret entry that currently holds a value. */
  isSet?: boolean;
}

/**
 * `auth` column shape. Modelled as `{ type, fields[] }` (rather than one bespoke interface per
 * `type`) for the same reason `env` is an array: bearer/basic/api_key each mix a secret field
 * (token / password / key value) with zero or more non-secret ones (username, header name), and a
 * single generic entry list lets the codec, the masking, and the "submitting null keeps it
 * unchanged" update rule all be written once instead of three times.
 *
 * Conventional field keys per type (enforced by the service layer, not by this type):
 * - `bearer`: `token` (secret)
 * - `basic`: `username`, `password` (secret)
 * - `api_key`: `headerName`, `value` (secret)
 */
export interface McpAuthConfig {
  type: 'bearer' | 'basic' | 'api_key';
  fields: McpSecretEntry[];
}

export interface McpEgressAuthConfig {
  type: 'bearer' | 'basic' | 'api_key';
  fields: McpEgressSecretEntry[];
}

/** One tool as reported by the server's `tools/list`, cached in `discovered_tools`. */
export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * One entry in `approved_tools`: a human's grant over a specific tool AT a specific schema.
 *
 * Adding the server is not the grant — see `acknowledgedHighRisk` on
 * {@link CreateMcpServerConfigDto}, which is the same distinction one level up (that one gates
 * *adding* a high-risk catalog server; nothing before this type gated its tools).
 */
export interface McpApprovedTool {
  name: string;
  /** sha256 hex over the canonicalised `inputSchema` — see `services/mcpToolDigest.ts`. */
  schemaDigest: string;
  /** ISO 8601. */
  approvedAt: string;
  /** User id, or `legacy:grandfathered` for a row converted from the pre-gate NULL state. */
  approvedBy: string;
}

export type McpToolApprovalState =
  /** Offered, approved, and the schema still digests to what was approved. */
  | 'approved'
  /** Offered but never approved — invisible to chat. */
  | 'new'
  /** Approved under a different schema; the capability changed — invisible to chat until re-approved. */
  | 'schema_changed'
  /** Approved, but the server no longer offers it. */
  | 'unavailable'
  /** Row predates the approval gate (`approved_tools IS NULL`); passthrough until the next connect. */
  | 'legacy';

/** Per-tool approval state, computed server-side so the digest has exactly one implementation. */
export interface McpToolApproval {
  name: string;
  /** Digest of what the server currently offers; `null` for an `unavailable` entry. */
  schemaDigest: string | null;
  state: McpToolApprovalState;
  approvedAt: string | null;
  /** Digest that was approved, when it differs from `schemaDigest` this is the drift. */
  approvedDigest: string | null;
}

/**
 * Body of `POST mcp/servers/:id/approve-tools`.
 *
 * `tools[]` carries the digest the client was actually shown; the server re-derives it from the
 * currently-discovered schema and rejects a mismatch, so a schema that drifted between the render
 * and the click cannot be approved sight-unseen. `approveAll` is the deliberate escape hatch — a
 * strict pin with no one-click path to re-bless a legitimately-updated upstream server is a pin
 * people turn off.
 */
export interface ApproveMcpToolsDto {
  approveAll?: boolean;
  tools?: Array<{ name: string; schemaDigest: string }>;
  /** Tool names to drop from the approved set. */
  revoke?: string[];
}

/** The full shape of a server config as the application layer works with it (decrypted). */
export interface McpServerConfigDraft {
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  env?: McpSecretEntry[];
  url?: string | null;
  auth?: McpAuthConfig | null;
}

export interface CreateMcpServerConfigDto extends McpServerConfigDraft {
  /** URL/tool-namespace-safe; derived from `name` when omitted. */
  slug?: string;
  enabled?: boolean;
  source?: McpConfigSource;
  catalogSlug?: string;
  /**
   * Required (and must be `true`) when `catalogSlug` names a high-risk catalog entry. Re-validated
   * server-side by {@link McpServerConfigService} regardless of what the client already showed the
   * user — see the high-risk catalog note in `catalog/mcpSuggestedCatalog.ts`.
   */
  acknowledgedHighRisk?: boolean;
}

export type UpdateMcpServerConfigDto = Partial<McpServerConfigDraft> & {
  enabled?: boolean;
};

/** Body of `POST mcp/test-connection` — an unsaved draft, probed without touching the DB. */
export type TestMcpServerConfigDraftDto = McpServerConfigDraft;

export interface McpServerConfigEgress {
  id: string;
  userId: string;
  name: string;
  slug: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: McpEgressSecretEntry[];
  url: string | null;
  auth: McpEgressAuthConfig | null;
  enabled: boolean;
  source: McpConfigSource;
  catalogSlug: string | null;
  discoveredTools: McpDiscoveredTool[] | null;
  approvedTools: McpApprovedTool[] | null;
  /** Derived from `discoveredTools` × `approvedTools`; the settings UI's drift view. */
  toolApprovals: McpToolApproval[];
  connectionStatus: McpConnectionStatus;
  lastConnectedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpProbeResult {
  success: boolean;
  tools?: McpDiscoveredTool[];
  error?: string;
}
