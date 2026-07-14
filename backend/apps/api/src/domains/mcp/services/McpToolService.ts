import { ForbiddenException, Injectable, type OnModuleInit } from '@nestjs/common';
import { z, type ZodTypeAny } from 'zod';

import type { RequestContext } from '@ci/common/context';
import { INTENTS_SCOPE } from '@ci/common/decorators';
import { type ApiKeyScopedRequest, isScopeLimitedApiKey } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { type JSONSchema, ToolRegistry, intentToolName } from '@ci/domains/tools';

import type { McpRegisteredTool } from '../types';

import { GraphQLToolAdapter } from './GraphQLToolAdapter';
import { McpExecutorService } from './McpExecutorService';

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
    if (!isScopeLimitedApiKey(req)) {
      return this.getTools();
    }

    const mayRunIntents = this.mayRunIntents(req);

    return this.getTools().filter((tool) => tool.source !== 'graphql' && mayRunIntents);
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

      return this.executorService.executeTool(graphqlTool, args, context);
    }

    if (!this.mayRunIntents(context.req)) {
      throw new ForbiddenException(
        `Tool "${name}" runs a CI intent, which requires the "${INTENTS_SCOPE}" scope this API key does not carry`,
      );
    }

    // Native tool execution
    const userId = (context.req.user as { id?: string })?.id;
    const requestContext: RequestContext = { userId };
    const result = await this.toolRegistry.executeTool(name, requestContext, args);

    if (!result.success) {
      throw new Error(result.error?.message ?? `Tool "${name}" execution failed`);
    }

    return result.data;
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
    // executable (underscored) names.
    const schemas = this.toolRegistry.getAgentFacingTools();

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
