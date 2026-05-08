import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import { McpExecutorService } from './McpExecutorService';
import { McpSchemaService } from './McpSchemaService';

@Injectable()
export class McpServerService implements OnModuleInit {
  private server: McpServer;

  constructor(
    private readonly schemaService: McpSchemaService,
    private readonly executorService: McpExecutorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext('McpServerService');
    this.server = new McpServer({
      name: 'companion-intelligence',
      version: '1.0.0',
    });
  }

  onModuleInit() {
    this.registerTools();
  }

  getServer(): McpServer {
    return this.server;
  }

  private registerTools() {
    const tools = this.schemaService.getTools();

    for (const tool of tools) {
      const handler = async (args: Record<string, unknown>, extra: { sessionId?: string }) => {
        try {
          const contextValue = {
            req: { sessionId: extra?.sessionId },
          };

          const result = await this.executorService.executeTool(tool, args, contextValue);

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
      this.server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        handler,
      );
    }

    this.logger.log('MCP tools registered', { count: tools.length });
  }
}
