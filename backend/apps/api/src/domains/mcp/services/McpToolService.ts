import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z, type ZodTypeAny } from 'zod';

import type { RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type JSONSchema, ToolRegistry } from '@ci/domains/tools';

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

    if (tool.source === 'graphql') {
      const graphqlTool = this.graphqlAdapter.getTools().find((t) => t.name === name);

      if (!graphqlTool) {
        throw new Error(`GraphQL tool not found: ${name}`);
      }

      return this.executorService.executeTool(graphqlTool, args, context);
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
        source: 'graphql',
      });
    }
  }

  private registerNativeTools() {
    // Agent-facing list: omits raw tools superseded by a curated intent (unless
    // CI_PREFER_INTENTS=false), so MCP clients are offered the intent, not both.
    const schemas = this.toolRegistry.getAgentFacingTools();

    for (const schema of schemas) {
      // Skip if a GraphQL tool with the same name already exists
      if (this.tools.has(schema.name)) {
        this.logger.debug(`Skipping native tool "${schema.name}" — name conflict with GraphQL tool`);

        continue;
      }

      this.tools.set(schema.name, {
        name: schema.name,
        description: schema.description,
        inputSchema: this.jsonSchemaToZodShape(schema.parameters),
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
