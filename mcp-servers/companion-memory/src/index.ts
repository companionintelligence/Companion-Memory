#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { CompanionMemoryClient, CompanionMemoryHttpError } from './client.js';
import { loadConfig } from './config.js';
import { buildToolset } from './tools.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new CompanionMemoryClient(config);
  const tools = buildToolset();
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    {
      name: 'companion-memory',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const tool = toolMap.get(name as never);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
    }

    try {
      const result = await tool.handler(client, request.params.arguments ?? {});

      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = errorToText(error);

      return {
        isError: true,
        content: [{ type: 'text', text: message }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`companion-memory MCP server connected (backend: ${config.COMPANION_MEMORY_URL})\n`);
}

function errorToText(error: unknown): string {
  if (error instanceof CompanionMemoryHttpError) {
    const detail = typeof error.body === 'string' ? error.body : JSON.stringify(error.body);

    return `${error.message}\n${detail}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

main().catch((error) => {
  process.stderr.write(`companion-memory failed to start: ${errorToText(error)}\n`);
  process.exit(1);
});
