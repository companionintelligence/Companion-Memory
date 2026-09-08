import { ForbiddenException, Injectable, type OnModuleInit } from '@nestjs/common';
import { z, type ZodTypeAny } from 'zod';

import { ContextService } from '@ci/common/context';
import { INTENTS_SCOPE, type ApiKeyCapability } from '@ci/common/decorators';
import { type ApiKeyScopedRequest, apiKeyCapabilityOf, isScopeLimitedApiKey } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import {
  type JSONSchema,
  type ToolInvocationContext,
  ToolRegistry,
  capabilityAllows,
  capabilityRequiredFor,
  intentToolName,
  outcomeOf,
  type ToolInvocationOutcome,
} from '@ci/domains/tools';

import type { McpRegisteredTool } from '../types';

import { GraphQLToolAdapter } from './GraphQLToolAdapter';
import { McpExecutorService } from './McpExecutorService';

// `capabilityAllows` used to be defined here, which made the privacy label mean something only to
// callers who arrived over MCP — the LLM dispatcher reached the same tools through a door with no
// lock on it. The rule now lives in `@ci/tool-core` (re-exported through `domains/tools/policy`,
// which is where it landed first) and is enforced inside ToolRegistry.executeTool for every
// transport; MCP keeps its pre-check because it owes its client a 403 with a specific message, not
// because it is the only thing standing there. Moving it into a Nest-free package was the same
// step taken once more: a transport that does not run inside this process — the CLI, an on-device
// dispatcher — can now apply the identical function instead of re-deriving it, which is how the
// rule stopped being MCP's in the first place.

@Injectable()
export class McpToolService implements OnModuleInit {
  private tools = new Map<string, McpRegisteredTool>();

  constructor(
    private readonly graphqlAdapter: GraphQLToolAdapter,
    private readonly toolRegistry: ToolRegistry,
    private readonly executorService: McpExecutorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext('McpToolService');
  }

  onModuleInit() {
    this.registerGraphQLTools();
    this.registerNativeTools();

    this.logger.log('MCP tools consolidated', {
      total: this.tools.size,
      graphql: this.graphqlAdapter.getTools().length,
      native: this.toolRegistry.getRegisteredToolNames().length,
    });
  }

  getTools(): McpRegisteredTool[] {
    return [...this.tools.values()];
  }

  /**
   * The tools this caller can actually execute.
   *
   * A scope-limited key reaches MCP with the `mcp` scope alone, but the tools behind
   * this endpoint are not one undifferentiated capability — they are the same two data
   * planes the REST routes gate separately, so MCP gates them the same way rather than
   * letting the transport become a way around the scopes:
   *
   * - GraphQL-derived tools run against the resolvers that serve `/graphql`, which
   *   declare no `@RequireScopes` — deny-by-default already rejects a scope-limited key
   *   on every one of them. Advertising them anyway would hand the model a catalog where
   *   each call fails with an opaque `Forbidden resource`.
   * - Native intents execute through the ToolRegistry, which performs NO authorization of
   *   its own; `knowledge.search` alone reads across the whole personal graph. They are
   *   the MCP face of the intent catalog, so they require the same {@link INTENTS_SCOPE}
   *   the REST catalog does — otherwise an `mcp`-only key, 403'd on `/api/intents`, would
   *   execute those very intents here.
   *
   * Both chat-agent connect keys already carry `intents` (see `scopesForApp`), so this
   * confines the hole without narrowing any key in the field. Full-authority principals
   * (sessions/JWT, and empty-scope keys such as the bulk importer's) still see every tool.
   */
  getToolsForRequest(req: ApiKeyScopedRequest): McpRegisteredTool[] {
    // Capability applies to every api-key principal, including empty-scope (full-surface) ones:
    // "sees every surface" and "may delete on it" are separate grants, and the importer key that
    // holds no scopes is exactly the credential that should be able to write without deleting.
    const capability = apiKeyCapabilityOf(req);
    const withinCapability = (tool: McpRegisteredTool) => capabilityAllows(tool.privacy, capability);

    if (!isScopeLimitedApiKey(req)) {
      return this.getTools().filter(withinCapability);
    }

    const mayRunIntents = this.mayRunIntents(req);

    return this.getTools().filter(
      (tool) => tool.source !== 'graphql' && mayRunIntents && withinCapability(tool),
    );
  }

  /**
   * Whether this caller may execute native intents — i.e. it is a full-authority
   * principal, or a scope-limited key carrying {@link INTENTS_SCOPE}.
   *
   * The single source of truth for that question, so the tools, the executor, and the
   * intent-catalog resource cannot disagree about who gets the intent plane.
   */
  mayRunIntents(req: ApiKeyScopedRequest): boolean {
    if (!isScopeLimitedApiKey(req)) {
      return true;
    }

    return req.apiKeyScopes?.includes(INTENTS_SCOPE) ?? false;
  }

  getSchemaSDL(): string {
    return this.graphqlAdapter.getSchemaSDL();
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: { req: import('express').Request },
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    // Belt-and-braces: getToolsForRequest already hides what this caller may not run,
    // but a client can name any tool directly, and the layers below do not re-check —
    // the GraphQL resolvers raise a bare `Forbidden resource`, and ToolRegistry performs
    // no authorization at all. This is the enforcement point; the catalog filter is only
    // the courtesy of not advertising what would fail.
    const scopeLimited = isScopeLimitedApiKey(context.req);
    const capability = apiKeyCapabilityOf(context.req);

    // Checked before the surface checks, because it is the answer that does not depend on which
    // plane the tool lives on: a read-only key is refused `deleteMemory` whether that tool came
    // from the GraphQL schema or the intent catalog, and the message should say so rather than
    // blaming the scope.
    if (!capabilityAllows(tool.privacy, capability)) {
      throw new ForbiddenException(
        `Tool "${name}" requires "${capabilityRequiredFor(tool.privacy)}" access, but this API key is "${capability}"`,
      );
    }

    if (tool.source === 'graphql') {
      if (scopeLimited) {
        throw new ForbiddenException(
          `Tool "${name}" reads the knowledge graph directly, which this scope-limited API key cannot access`,
        );
      }

      const graphqlTool = this.graphqlAdapter.getTools().find((t) => t.name === name);

      if (!graphqlTool) {
        throw new Error(`GraphQL tool not found: ${name}`);
      }

      // This plane never touches ToolRegistry — it returns through the GraphQL executor — so it
      // was the one dispatcher that emitted no `tool.invoked` at all and left no ledger row. An
      // MCP client calling `deleteMemory` here was invisible to exactly the surface built to see
      // it. Recorded through the registry so there is still one emit path, not two.
      const startedAt = Date.now();

      try {
        const data = await this.executorService.executeTool(graphqlTool, args, context);

        await this.recordGraphqlInvocation(tool, context.req, capability, {
          outcome: 'success',
          durationMs: Date.now() - startedAt,
        });

        return data;
      } catch (error) {
        const failure = { success: false, error: describeFailure(error) };

        await this.recordGraphqlInvocation(tool, context.req, capability, {
          outcome: outcomeOf(failure),
          errorCode: failure.error.code,
          error: failure.error.message,
          durationMs: Date.now() - startedAt,
        });

        throw error;
      }
    }

    if (!this.mayRunIntents(context.req)) {
      throw new ForbiddenException(
        `Tool "${name}" runs a CI intent, which requires the "${INTENTS_SCOPE}" scope this API key does not carry`,
      );
    }

    // Native tool execution. The capability travels WITH the call rather than being left behind at
    // the transport: the registry re-checks it, so the pre-check above is the courtesy of a precise
    // 403 and this is what actually authorizes the execution.
    const userId = (context.req.user as { id?: string })?.id;
    // Spread the ambient request context rather than building one from scratch: `traceId` and
    // `apiKeyId` live there (ApiKeyStrategy stamps the latter), and a hand-built literal dropped
    // both — which made every MCP-originated row in the tool-invocation ledger record a NULL actor
    // and no correlation id.
    const invocationContext: ToolInvocationContext = {
      ...ContextService.getContext(),
      userId,
      capability,
    };
    const result = await this.toolRegistry.executeTool(name, invocationContext, args);

    if (!result.success) {
      throw new Error(result.error?.message ?? `Tool "${name}" execution failed`);
    }

    return result.data;
  }

  /**
   * Append one GraphQL-plane call to the tool-invocation ledger.
   *
   * `intent` is the GraphQL operation name because that is the only id this plane has — there is
   * no dotted intent behind it — and `source: 'graphql'` is what tells a reader that, so the two
   * planes stay distinguishable in one table. Never throws: telemetry must not turn a completed
   * GraphQL call into a failed one.
   */
  private async recordGraphqlInvocation(
    tool: McpRegisteredTool,
    req: ApiKeyScopedRequest,
    capability: ApiKeyCapability,
    outcome: {
      outcome: ToolInvocationOutcome;
      errorCode?: string;
      error?: string;
      durationMs?: number;
    },
  ): Promise<void> {
    const context = ContextService.getContext();

    await this.toolRegistry.recordInvocation({
      intent: tool.name,
      tool: tool.name,
      source: 'graphql',
      userId: (req.user as { id?: string } | undefined)?.id ?? context?.userId,
      correlationId: context?.traceId,
      apiKeyId: req.apiKeyId ?? context?.apiKeyId,
      capability,
      occurredAt: new Date().toISOString(),
      access: tool.privacy.access,
      external: tool.privacy.external,
      destructive: tool.privacy.destructive,
      ...outcome,
    });
  }

  private registerGraphQLTools() {
    for (const tool of this.graphqlAdapter.getTools()) {
      this.tools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // Carry the synthesized label so auto-wrapped CRUD is advertised (and gated) with the same
        // privacy metadata as native intents rather than slipping through unlabelled.
        privacy: tool.privacy,
        source: 'graphql',
      });
    }
  }

  private registerNativeTools() {
    // Every registered tool is a curated intent; advertise them all to MCP clients under their
    // executable (underscored) names. `getOutboundCatalogTools` (rather than the agent-facing
    // full list) excludes tools sourced from a user's own external MCP servers — re-publishing
    // those here would let a client reach back through CI-Server's own MCP server to that same
    // external server, a recursive re-exposure this endpoint does not exist to provide.
    const schemas = this.toolRegistry.getOutboundCatalogTools();

    for (const schema of schemas) {
      // schema.name is the dotted intent id; expose/execute by the MCP-safe executable name.
      const toolName = intentToolName(schema.name);

      // Skip if a GraphQL tool with the same name already exists
      if (this.tools.has(toolName)) {
        this.logger.debug(`Skipping native tool "${toolName}" — name conflict with GraphQL tool`);

        continue;
      }

      this.tools.set(toolName, {
        name: toolName,
        description: schema.description,
        inputSchema: this.jsonSchemaToZodShape(schema.parameters),
        privacy: schema.privacy,
        source: 'native',
      });
    }
  }

  private jsonSchemaToZodShape(schema: JSONSchema): Record<string, ZodTypeAny> {
    const shape: Record<string, ZodTypeAny> = {};
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);

    for (const [key, prop] of Object.entries(properties)) {
      let zodType = this.jsonPropertyToZod(prop);

      if (prop.description) {
        zodType = zodType.describe(prop.description);
      }

      if (!required.has(key)) {
        zodType = zodType.optional();
      }

      shape[key] = zodType;
    }

    return shape;
  }

  private jsonPropertyToZod(prop: JSONSchema): ZodTypeAny {
    if (prop.enum && prop.enum.length > 0) {
      const values = prop.enum.map(String) as [string, ...string[]];

      return z.enum(values);
    }

    switch (prop.type) {
      case 'string':
        return z.string();
      case 'number':
        return z.number();
      case 'integer': {
        let schema = z.number().int();

        if (typeof prop.minimum === 'number') {
          schema = schema.min(prop.minimum);
        }

        if (typeof prop.maximum === 'number') {
          schema = schema.max(prop.maximum);
        }

        return schema;
      }

      case 'boolean':
        return z.boolean();
      case 'array':
        if (prop.items) {
          return z.array(this.jsonPropertyToZod(prop.items));
        }

        return z.array(z.unknown());
      case 'object':
        if (prop.properties) {
          return z.object(this.jsonSchemaToZodShape(prop));
        }

        return z.record(z.unknown());
      default:
        return z.unknown();
    }
  }
}

/**
 * Shape a thrown GraphQL-plane error like a `ToolError` so one `outcomeOf` decides the outcome for
 * both planes.
 *
 * The exception CLASS is the code, because the class is the closest thing this plane has to the
 * error code the intent plane supplies: a Nest `ForbiddenException` and a driver `TimeoutError`
 * are exactly the distinction the `outcome` column is trying to preserve. Read off
 * `constructor.name` rather than `error.name`, which is the string `'Error'` for any subclass that
 * did not bother to set it.
 */
export function describeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (!(error instanceof Error)) {
    return { code: 'UNKNOWN_ERROR', message: String(error), retryable: false };
  }

  return {
    code: error.constructor?.name ?? error.name ?? 'UNKNOWN_ERROR',
    message: error.message,
    retryable: false,
  };
}
