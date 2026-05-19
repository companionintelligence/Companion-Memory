import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { LoggerService } from '@ci/common/logging';

import { McpPromptService } from './McpPromptService';
import { McpResourceSubscriber } from './McpResourceSubscriber';
import { McpToolService } from './McpToolService';

export interface CreatedMcpServer {
  server: McpServer;
  /** Call when the underlying transport closes to unsubscribe from pubsub. */
  cleanup(): void;
}

@Injectable()
export class McpServerService {
  constructor(
    private readonly toolService: McpToolService,
    private readonly promptService: McpPromptService,
    private readonly resourceSubscriber: McpResourceSubscriber,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext('McpServerService');
  }

  /**
   * Build a per-session MCP server. The caller (McpController) must invoke
   * the returned `cleanup` on transport close so resource-subscription
   * listeners don't leak.
   */
  createServer(req: Request): CreatedMcpServer {
    const server = new McpServer({
      name: 'companion-memory',
      version: '0.1.0',
    });

    this.registerTools(server, req);
    this.registerResources(server);
    this.promptService.register(server, req);
    const unsubscribe = this.resourceSubscriber.register(server, req);

    return { server, cleanup: unsubscribe };
  }

  private registerResources(server: McpServer) {
    server.registerResource(
      'graphql-schema',
      'schema://graphql',
      {
        description: 'The full GraphQL SDL schema describing all available types, queries, and mutations',
      },
      (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/plain',
            text: this.toolService.getSchemaSDL(),
          },
        ],
      }),
    );
  }

  private registerTools(server: McpServer, req: Request) {
    const tools = this.toolService.getTools();

    for (const tool of tools) {
      const handler = async (args: Record<string, unknown>) => {
        try {
          const result = await this.toolService.executeTool(tool.name, args, { req });

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));

          this.logger.error(error, `MCP tool execution failed: ${tool.name}`);

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: error.message }),
              },
            ],
            isError: true,
          };
        }
      };

      // @ts-expect-error -- dynamic Zod shapes cause excessive type depth in registerTool generics
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        handler,
      );
    }

    this.logger.log('MCP tools registered', {
      count: tools.length,
    });
  }
}
