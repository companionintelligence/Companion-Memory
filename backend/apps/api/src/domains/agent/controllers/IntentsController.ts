import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { Context, type RequestContext } from '@ci/common/context';
import { INTENTS_SCOPE, READ_CAPABILITY, RequireCapability, RequireScopes } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard, type ApiKeyScopedRequest, apiKeyCapabilityOf } from '@ci/common/guards';
import {
  DISPATCH_TIERS,
  IntentCatalogService,
  ToolRegistry,
  intentToolName,
  type CiEntityDescriptor,
  type DispatchTier,
  type IntentDomain,
  type IntentManifest,
  type ManifestIntent,
  type ToolResult,
} from '@ci/domains/tools';

/**
 * Publishes the CI Intent catalog and runs those intents through ToolRegistry.
 *
 * Catalog GETs and execute POSTs are reached at `/api/intents` (legacy) and
 * `/api/agent/intents` (canonical for Hermes / OpenClaw). Scope-limited connect
 * keys need the `intents` scope. Session/JWT and empty-scope keys are unaffected.
 *
 * The mount deliberately OMITS the `api/` those public URLs carry. The gateway
 * proxies under `location /api/` and strips the prefix before forwarding
 * (`rewrite ^/api/(.*)$ /$1 break`, infrastructure/gateway/nginx.conf), and the
 * app sets no `setGlobalPrefix`, so controller paths are literal. Mounting
 * `api/intents` here — as this controller did until CI-Server#1684 — means a
 * client asking for `/api/agent/intents` arrives as `/agent/intents` and matches
 * nothing; the only working URL was the absurd `/api/api/agent/intents`. Both
 * harness plugins swallowed the resulting 404 and silently dropped the catalog,
 * so agents fell back to raw CRUD instead of these privacy-labelled intents.
 * `controllerGatewayPrefix.test.ts` keeps the whole class of bug out.
 *
 * GET is read-only. POST uses `@RequireCapability(READ_CAPABILITY)` as the HTTP
 * floor so a read-only key can still run read intents; ToolRegistry.executeTool
 * is the verb gate (`suggestions.feedback` needs write).
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@RequireScopes(INTENTS_SCOPE)
@Controller(['intents', 'agent/intents'])
export class IntentsController {
  constructor(
    private readonly catalog: IntentCatalogService,
    private readonly registry: ToolRegistry,
  ) {}

  /**
   * The full manifest: domains + entities + intents.
   *
   * `?tier=local` additionally attaches this server's own dispatch ruling to each intent, which is
   * what the on-device tier should ask for — it reads `dispatch.decision` rather than shipping a
   * Kotlin and a Swift copy of the policy. Omitting `tier` returns the manifest unchanged.
   */
  @Get()
  @RequireCapability(READ_CAPABILITY)
  getManifest(@Query('tier') tier?: string): IntentManifest {
    return this.catalog.getManifest({ tier: parseTier(tier) });
  }

  /** The standardized schema-domain vocabulary. */
  @Get('domains')
  @RequireCapability(READ_CAPABILITY)
  getDomains(): { domains: IntentDomain[] } {
    return { domains: this.catalog.getDomains() };
  }

  /** The entity registry. */
  @Get('entities')
  @RequireCapability(READ_CAPABILITY)
  getEntities(): { entities: CiEntityDescriptor[] } {
    return { entities: this.catalog.getEntities() };
  }

  /** A single intent by its dotted name, e.g. `memory.recall`. Honours `?tier=` as above. */
  @Get(':name')
  @RequireCapability(READ_CAPABILITY)
  getIntent(@Param('name') name: string, @Query('tier') tier?: string): ManifestIntent {
    const manifest = this.catalog.getManifest({ tier: parseTier(tier) });
    const intent = manifest.intents.find((i) => i.name === name);

    if (!intent) {
      throw new NotFoundException(`Unknown intent: ${name}`);
    }

    return intent;
  }

  /**
   * Execute a catalog intent. Body is the raw tool input JSON (Hermes `_post(path, arguments)`).
   * Path name may be dotted (`insights.explain`) or underscored (`insights_explain`).
   * Unknown intent → HTTP 404 so harnesses fall through to the other prefix.
   * Known intent → HTTP 200 ToolResult, including `success: false`.
   *
   * `?tier=local` states that the call originated on the on-device tier — the same vocabulary the
   * GET routes already publish rulings under, now honoured on the way IN. It is what makes
   * `resolveDispatch`'s three `queue` reasons reachable at the execute chokepoint: an intent the
   * device may not perform on-device is parked as a pending action (HTTP 200, `TOOL_QUEUED`) for
   * the owner to confirm, rather than silently running with the device's say-so. Omitting it means
   * `appliance`, which is every existing caller and is unchanged.
   */
  @Post(':name/execute')
  @HttpCode(200)
  @RequireCapability(READ_CAPABILITY)
  async execute(
    @Param('name') name: string,
    @Body() body: unknown,
    @Context() context: RequestContext,
    @Req() req: ApiKeyScopedRequest,
    @Query('tier') tier?: string,
  ): Promise<ToolResult> {
    const toolName = resolveExecuteName(name);

    if (!toolName || !this.registry.hasTool(toolName)) {
      throw new NotFoundException(`Unknown intent: ${name}`);
    }

    return this.registry.executeTool(
      toolName,
      { ...context, capability: apiKeyCapabilityOf(req), tier: parseTier(tier) },
      body ?? {},
    );
  }
}

/**
 * Validates the optional `tier` query param. Rejects an unrecognized value rather than ignoring it:
 * a client that asks for rulings and silently receives none would read every `dispatch` as
 * `undefined` and, depending on how it defaults, either refuse everything or run everything.
 */
function parseTier(tier: string | undefined): DispatchTier | undefined {
  if (tier == null || tier === '') {
    return undefined;
  }

  if (!(DISPATCH_TIERS as readonly string[]).includes(tier)) {
    throw new BadRequestException(
      `Unknown dispatch tier: ${tier}. Expected one of: ${DISPATCH_TIERS.join(', ')}`,
    );
  }

  return tier as DispatchTier;
}

/** Decode a path segment and map dotted intent ids onto the registry's underscored keys. */
function resolveExecuteName(raw: string): string | null {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }

  name = name.trim();
  if (!name) {
    return null;
  }

  return intentToolName(name);
}
