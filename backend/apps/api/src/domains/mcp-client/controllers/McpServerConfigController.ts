import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { AdminOnlyGuard, JwtOrPortalAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { getMcpSuggestedCatalog } from '../catalog/mcpSuggestedCatalog';
import { McpServerConfigService } from '../services/McpServerConfigService';
import type {
  ApproveMcpToolsDto,
  CreateMcpServerConfigDto,
  TestMcpServerConfigDraftDto,
  UpdateMcpServerConfigDto,
} from '../types';

const mcpSecretEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string().nullable(),
  secret: z.boolean(),
  label: z.string().optional(),
});

const mcpAuthConfigSchema = z.object({
  type: z.enum(['bearer', 'basic', 'api_key']),
  fields: z.array(mcpSecretEntrySchema),
});

const mcpDraftSchema = z.object({
  name: z.string().min(1).max(255),
  transport: z.enum(['stdio', 'http']),
  command: z.string().min(1).nullable().optional(),
  args: z.array(z.string()).optional(),
  env: z.array(mcpSecretEntrySchema).optional(),
  url: z.string().min(1).nullable().optional(),
  auth: mcpAuthConfigSchema.nullable().optional(),
});

const createMcpServerConfigSchema = mcpDraftSchema.extend({
  slug: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  source: z.enum(['user_added', 'catalog']).optional(),
  catalogSlug: z.string().optional(),
  acknowledgedHighRisk: z.boolean().optional(),
});

const updateMcpServerConfigSchema = mcpDraftSchema.partial().extend({
  enabled: z.boolean().optional(),
});

/**
 * `tools[].schemaDigest` is required, not optional: it is the digest the client was actually shown,
 * and {@link McpServerConfigService.approveTools} re-derives and compares it. An approve request
 * that cannot say which schema it reviewed is not an approval.
 */
const approveMcpToolsSchema = z
  .object({
    approveAll: z.boolean().optional(),
    tools: z.array(z.object({ name: z.string().min(1), schemaDigest: z.string().min(1) })).optional(),
    revoke: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (value) => value.approveAll === true || (value.tools?.length ?? 0) > 0 || (value.revoke?.length ?? 0) > 0,
    {
      message: 'Specify approveAll, tools, or revoke',
    },
  );

/**
 * `@Controller('mcp')` sub-routes, all under `mcp/servers` (plus `mcp/catalog` and the bare
 * `mcp/test-connection`) — verified against `McpController` (the outbound `/api/mcp` protocol
 * endpoint, which owns exactly bare `POST`/`GET`/`DELETE` on `/api/mcp` itself) to not collide.
 *
 * Every route uses {@link JwtOrPortalAuthGuard}, never an api key: stdio transport is arbitrary
 * local command execution, a materially bigger capability than an api key should ever be able to
 * reach (same rationale as `ApiKeyController`). Every route that manages a server config — create,
 * update, delete, enable, disable, AND test-connection (which, for a stdio config, spawns exactly
 * the same local process a real connect would) — additionally requires {@link AdminOnlyGuard}.
 * Listing the caller's own configs and browsing the read-only suggested catalog do not.
 */
@Controller('mcp')
export class McpServerConfigController {
  constructor(private readonly configService: McpServerConfigService) {}

  @UseGuards(JwtOrPortalAuthGuard)
  @Get('servers')
  async list(@Context() context: RequestContext) {
    const { userId } = toServiceContext(context);

    return this.configService.listForUser(userId);
  }

  @UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)
  @Post('servers')
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createMcpServerConfigSchema)) input: CreateMcpServerConfigDto,
  ) {
    const { userId } = toServiceContext(context);

    return this.configService.create(userId, input);
  }

  @UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)
  @Patch('servers/:id')
  async update(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(updateMcpServerConfigSchema)) input: UpdateMcpServerConfigDto,
  ) {
    const { userId } = toServiceContext(context);

    return this.configService.update(userId, id, input);
  }

  @UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)
  @Delete('servers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Context() context: RequestContext, @Param('id') id: string): Promise<void> {
    const { userId } = toServiceContext(context);

    await this.configService.remove(userId, id);
  }

  @UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)
  @Post('servers/:id/enable')
  async enable(@Context() context: RequestContext, @Param('id') id: string) {
    const { userId } = toServiceContext(context);

    return this.configService.setEnabled(userId, id, true);
  }

  @UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)
  @Post('servers/:id/disable')
  async disable(@Context() context: RequestContext, @Param('id') id: string) {
    const { userId } = toServiceContext(context);

    return this.configService.setEnabled(userId, id, false);
  }

  /**
   * Installing the server is not the grant; approving its tools is. Admin-gated like every other
   * config mutation — an approval widens what the assistant can reach out and do.
   */
  @UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)
  @Post('servers/:id/approve-tools')
  async approveTools(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(approveMcpToolsSchema)) input: ApproveMcpToolsDto,
  ) {
    const { userId } = toServiceContext(context);

    return this.configService.approveTools(userId, id, input);
  }

  @UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)
  @Post('servers/:id/test-connection')
  async testConnection(@Context() context: RequestContext, @Param('id') id: string) {
    const { userId } = toServiceContext(context);

    return this.configService.testConnection(userId, id);
  }

  @UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)
  @Post('test-connection')
  async testDraftConnection(@Body(new ValidationPipe(mcpDraftSchema)) input: TestMcpServerConfigDraftDto) {
    return this.configService.testDraftConnection(input);
  }

  @UseGuards(JwtOrPortalAuthGuard)
  @Get('catalog')
  async catalog() {
    return getMcpSuggestedCatalog();
  }
}
