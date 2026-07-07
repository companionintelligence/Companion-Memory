import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { Context, type RequestContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import {
  IntentCatalogService,
  ToolRegistry,
  intentToolName,
  type CiEntityDescriptor,
  type IntentDomain,
  type IntentManifest,
  type ManifestIntent,
  type ToolResult,
} from '@ci/domains/tools';

/**
 * Publishes the CI Intent catalog — the discoverable, typed capability declaration. Any agent
 * (CI-Hermes, CI-OpenClaw, an external MCP client) can read one catalog here instead of
 * re-implementing bespoke integration glue.
 *
 * Also exposes the uniform REST execution path (`POST /api/intents/:name/execute`) so pure-REST
 * harnesses execute curated intents without speaking MCP (CI-Engineering #59).
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Controller('api/intents')
export class IntentsController {
  constructor(
    private readonly catalog: IntentCatalogService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  /** The full manifest: domains + entities + intents. */
  @Get()
  getManifest(): IntentManifest {
    return this.catalog.getManifest();
  }

  /** The standardized schema-domain vocabulary. */
  @Get('domains')
  getDomains(): { domains: IntentDomain[] } {
    return { domains: this.catalog.getDomains() };
  }

  /** The entity registry. */
  @Get('entities')
  getEntities(): { entities: CiEntityDescriptor[] } {
    return { entities: this.catalog.getEntities() };
  }

  /** A single intent by its dotted name, e.g. `memory.recall`. */
  @Get(':name')
  getIntent(@Param('name') name: string): ManifestIntent {
    const manifest = this.catalog.getManifest();
    const intent = manifest.intents.find((i) => i.name === name);

    if (!intent) {
      throw new NotFoundException(`Unknown intent: ${name}`);
    }

    return intent;
  }

  /**
   * Execute an intent by name — the uniform REST execution path for agent harnesses
   * (CI-Engineering #59). Accepts the dotted intent id (`predictions.forecast`) or its
   * executable form (`predictions_forecast`); the JSON body is the tool input and is validated
   * by the tool's own input schema, exactly as MCP tool calls are.
   *
   * Returns the structured {@link ToolResult} (success/data/error), never the raw tool throw.
   *
   * TODO(companionintelligence/CI-Server#1633): route this through IntentDispatcherService once
   * the dispatcher PR lands, replacing the inline destructive/external policy gate below with
   * the shared policy engine (confirmation flows, per-app grants).
   */
  @Post(':name/execute')
  @HttpCode(200)
  async executeIntent(
    @Param('name') name: string,
    @Context() context: RequestContext,
    @Body() input: Record<string, unknown> | undefined,
  ): Promise<ToolResult> {
    const toolName = intentToolName(name);
    const schema = this.toolRegistry
      .getAgentFacingTools(context)
      .find((s) => intentToolName(s.name) === toolName);

    if (!schema) {
      throw new NotFoundException(`Unknown intent: ${name}`);
    }

    // Inline policy gate: this generic executor only runs read-only, appliance-local intents.
    // Destructive or external intents need the dispatcher's confirmation/grant flow (see TODO).
    if (schema.privacy.destructive || schema.privacy.external) {
      throw new ForbiddenException(
        `Intent ${schema.name} is ${schema.privacy.destructive ? 'destructive' : 'external'} and cannot be executed via the generic REST executor`,
      );
    }

    // Same execution path MCP uses: ToolRegistry.executeTool with the owner-bound user context.
    return this.toolRegistry.executeTool(toolName, context, input ?? {});
  }
}
