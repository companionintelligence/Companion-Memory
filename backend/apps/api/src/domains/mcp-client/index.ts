/**
 * User-configured connections to external Model Context Protocol servers (stdio or HTTP),
 * treated as a SECOND tool provider alongside CI-Server's native one.
 *
 * ### Key components
 * - **`McpServerConfigEntity`** / `ci.mcp_server_configs`: one row per configured server.
 * - **`McpSecretCodec`**: per-field AES-256-GCM encrypt/decrypt for `env`/`auth` secret values.
 * - **`McpClientManagerService`**: owns every live connection (connect/disconnect/reconnect
 *   backoff/probe), and is the only place a secret is ever decrypted to a real value.
 * - **`mcpToolDigest`**: the pinning primitive — sha256 over each tool's canonicalised
 *   `inputSchema` (sorted keys, prose stripped), plus the approved/new/drifted diff the settings UI
 *   renders. One implementation, shared by the provider's intersect and the approve endpoint.
 * - **`McpToolProvider`**: wraps every APPROVED discovered tool as a `McpDynamicTool`; assistant-only
 *   (`includeInOutboundCatalog = false`) so nothing here is re-exposed on CI-Server's own outbound
 *   `/api/intents` or MCP server surface.
 * - **`McpToolsRegistrationService`**: registers the provider and runs the boot-time connect sweep,
 *   from this module's own `OnModuleInit` — see its doc comment for why (the same
 *   circular-import shape `PersonaToolsRegistrationService` documents, plus a lifecycle-ordering
 *   hazard direct wiring into `ToolsRegistrationService` would have introduced).
 * - **`McpServerConfigService`** / **`McpServerConfigController`**: the `mcp/servers` +
 *   `mcp/catalog` REST surface — see B5 in the implementation plan for the exact contract.
 *
 * @module McpClientModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ToolsModule } from '@ci/domains/tools';

import { McpServerConfigController } from './controllers/McpServerConfigController';
import { McpServerConfigEntity } from './entities/McpServerConfigEntity';
import { McpToolProvider } from './providers/McpToolProvider';
import { McpClientManagerService } from './services/McpClientManagerService';
import { McpSecretCodec } from './services/McpSecretCodec';
import { McpServerConfigService } from './services/McpServerConfigService';
import { McpToolsRegistrationService } from './services/McpToolsRegistrationService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([McpServerConfigEntity]), ToolsModule],
  providers: [
    McpSecretCodec,
    McpClientManagerService,
    McpToolProvider,
    McpServerConfigService,
    McpToolsRegistrationService,
  ],
  controllers: [McpServerConfigController],
})
export class McpClientModule {}

export { McpClientManagerService } from './services/McpClientManagerService';
export { McpServerConfigService } from './services/McpServerConfigService';
export { McpServerConfigEntity } from './entities/McpServerConfigEntity';
export { getMcpSuggestedCatalog, HIGH_RISK_CATALOG_SLUGS } from './catalog/mcpSuggestedCatalog';
export type { McpCatalogEntry } from './catalog/mcpSuggestedCatalog';
export type {
  ApproveMcpToolsDto,
  CreateMcpServerConfigDto,
  McpApprovedTool,
  McpAuthConfig,
  McpConnectionStatus,
  McpDiscoveredTool,
  McpEgressAuthConfig,
  McpEgressSecretEntry,
  McpProbeResult,
  McpSecretEntry,
  McpServerConfigDraft,
  McpServerConfigEgress,
  McpToolApproval,
  McpToolApprovalState,
  McpTransport,
  TestMcpServerConfigDraftDto,
  UpdateMcpServerConfigDto,
} from './types';
