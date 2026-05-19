import { ForbiddenException, Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { z, type ZodTypeAny } from 'zod';

import type { RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { AuthDenialLogger, matchScopes, missingScopes, SCOPES } from '@ci/common/scopes';
import { type JSONSchema, ToolRegistry } from '@ci/domains/tools';

import type { McpRegisteredTool } from '../types';

import { GraphQLToolAdapter } from './GraphQLToolAdapter';
import { McpExecutorService } from './McpExecutorService';

interface ApiKeyAuthMarker {
  scopes: string[];
  keyId: string;
  actorId: string;
}

@Injectable()
export class McpToolService implements OnModuleInit {
  private tools = new Map<string, McpRegisteredTool>();

  constructor(
    private readonly graphqlAdapter: GraphQLToolAdapter,
    private readonly toolRegistry: ToolRegistry,
    private readonly executorService: McpExecutorService,
    private readonly logger: LoggerService,
    @Optional() @Inject(AuthDenialLogger) private readonly denialLogger?: AuthDenialLogger,
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

    this.assertScopesSatisfied(tool, context.req);

    if (tool.source === 'graphql') {
      const graphqlTool = this.graphqlAdapter.getTools().find((t) => t.name === name);

      if (!graphqlTool) {
        throw new Error(`GraphQL tool not found: ${name}`);
      }

      return this.executorService.executeTool(graphqlTool, args, context);
    }

    // Native tool execution
    const userId = (context.req.user as { id?: string })?.id;
    const apiKeyAuth = (context.req as { apiKeyAuth?: ApiKeyAuthMarker }).apiKeyAuth;
    const requestContext: RequestContext = { userId, actorId: apiKeyAuth?.actorId ?? userId };
    const result = await this.toolRegistry.executeTool(name, requestContext, args);

    if (!result.success) {
      throw new Error(result.error?.message ?? `Tool "${name}" execution failed`);
    }

    return result.data;
  }

  /**
   * Throw 403 if the calling API key lacks any of the tool's required scopes.
   * Session-JWT callers (no `apiKeyAuth` marker) are not checked — the human
   * owner browsing their own twin always has full access.
   */
  private assertScopesSatisfied(tool: McpRegisteredTool, req: import('express').Request) {
    if (tool.requiredScopes.length === 0) {
      return;
    }

    const apiKeyAuth = (req as { apiKeyAuth?: ApiKeyAuthMarker }).apiKeyAuth;
    if (!apiKeyAuth) {
      return;
    }

    if (matchScopes(apiKeyAuth.scopes, tool.requiredScopes)) {
      return;
    }

    const missing = missingScopes(apiKeyAuth.scopes, tool.requiredScopes);

    this.denialLogger?.record({
      actorId: apiKeyAuth.actorId,
      apiKeyId: apiKeyAuth.keyId,
      reason: 'insufficient_scope',
      requiredScopes: tool.requiredScopes,
      grantedScopes: apiKeyAuth.scopes,
      route: 'mcp:tools/call',
      toolName: tool.name,
      extra: { missing },
    });

    throw new ForbiddenException({
      error: 'insufficient_scope',
      tool: tool.name,
      missing,
      required: tool.requiredScopes,
    });
  }

  private registerGraphQLTools() {
    for (const tool of this.graphqlAdapter.getTools()) {
      // Query → read scope. Mutation → write scope. Per-resolver overrides
      // via an @AuthScope GraphQL directive land in a follow-up; until then
      // mutations require memory:write as a conservative default.
      const requiredScopes = tool.operationType === 'mutation' ? [SCOPES.MEMORY_WRITE] : [SCOPES.MEMORY_READ];

      this.tools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        source: 'graphql',
        requiredScopes,
      });
    }
  }

  private registerNativeTools() {
    const schemas = this.toolRegistry.getAvailableTools();

    for (const schema of schemas) {
      // Skip if a GraphQL tool with the same name already exists
      if (this.tools.has(schema.name)) {
        this.logger.debug(`Skipping native tool "${schema.name}" — name conflict with GraphQL tool`);

        continue;
      }

      // Native tools self-declare via ToolSchema.requiredScopes. If they don't,
      // default to tools:invoke:<name> so the MCP layer always knows what's
      // being asked of the caller.
      const requiredScopes = schema.requiredScopes ?? [`${SCOPES.TOOLS_INVOKE}:${schema.name}`];

      this.tools.set(schema.name, {
        name: schema.name,
        description: schema.description,
        inputSchema: this.jsonSchemaToZodShape(schema.parameters),
        source: 'native',
        requiredScopes,
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
