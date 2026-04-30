import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { authMatches, createMcpServer } from '../src/server';

class LoopbackTransport implements Transport {
  peer?: LoopbackTransport;

  onclose?: () => void;

  onerror?: (error: Error) => void;

  onmessage?: (message: JSONRPCMessage) => void;

  sessionId?: string;

  setProtocolVersion?: (version: string) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => {
      this.peer?.onmessage?.(message);
    });
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function createTransportPair() {
  const clientTransport = new LoopbackTransport();
  const serverTransport = new LoopbackTransport();

  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;

  return {
    clientTransport,
    serverTransport,
  };
}

function readTextContent(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string') {
    return payload.text;
  }

  return '';
}

test('rejects invalid bearer tokens', () => {
  assert.equal(authMatches('expected-token', undefined), false);
  assert.equal(authMatches('expected-token', 'Bearer wrong-token'), false);
  assert.equal(authMatches('expected-token', 'Bearer expected-token'), true);
});

test('supports MCP discovery and tool execution', async () => {
  const server = createMcpServer(
    {
      getCapabilities: async () => ({
        owner: {
          userId: 'owner-user-id',
          selection: 'configured',
        },
        tools: [
          { name: 'search_memory', description: 'search tool' },
          { name: 'get_user_context', description: 'context tool' },
        ],
        resources: [
          { uri: 'ci://capabilities/overview', description: 'overview' },
          { uri: 'ci://user/context', description: 'context' },
        ],
        graphql: {
          queryCount: 2,
          mutationCount: 1,
          queries: ['me', 'search'],
          mutations: ['createNote'],
        },
      }),
      getUserContext: async () => ({
        context: {
          currentUser: {
            entityId: 'entity-1',
            name: 'Owner',
            username: 'owner',
          },
        },
        markdown: '# User Context',
      }),
      searchMemory: async () => ({
        results: [{ id: 'person-1', type: 'person', title: 'Owner', summary: 'Test owner', timestamp: null }],
        truncated: false,
      }),
      readEntityGraph: async (payload: Record<string, unknown>) => ({
        seedEntityIds: [payload.entityId ?? 'entity-1'],
        nodes: [],
        edges: [],
        stats: {
          nodeCount: 0,
          edgeCount: 0,
          truncatedNodes: false,
          truncatedEdges: false,
        },
      }),
      getRecentActivity: async () => ({
        activity: [],
        summaries: [],
        actions: [],
      }),
      getThread: async (threadId: string) => ({
        thread: {
          id: threadId,
          name: 'Thread',
          description: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        action: null,
        messages: [],
        truncated: false,
        totalMessages: 0,
      }),
      getDocument: async (documentId: string) => ({
        id: documentId,
        filename: 'doc.txt',
        title: 'Doc',
        description: null,
        contentType: 'text/plain',
        size: 10,
        sourceUrl: null,
        previewUrl: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        text: 'hello',
        textTruncated: false,
      }),
    } as unknown as Parameters<typeof createMcpServer>[0],
    'test',
  );
  const { clientTransport, serverTransport } = createTransportPair();
  const client = new Client({
    name: 'ci-mcp-test-client',
    version: '1.0.0',
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.request(
    {
      method: 'tools/list',
      params: {},
    },
    ListToolsResultSchema,
  );
  const resources = await client.request(
    {
      method: 'resources/list',
      params: {},
    },
    ListResourcesResultSchema,
  );
  const prompts = await client.request(
    {
      method: 'prompts/list',
      params: {},
    },
    ListPromptsResultSchema,
  );
  const userContext = await client.request(
    {
      method: 'resources/read',
      params: {
        uri: 'ci://user/context',
      },
    },
    ReadResourceResultSchema,
  );
  const prompt = await client.request(
    {
      method: 'prompts/get',
      params: {
        name: 'ci_memory_usage',
      },
    },
    GetPromptResultSchema,
  );
  const toolResult = await client.request(
    {
      method: 'tools/call',
      params: {
        name: 'search_memory',
        arguments: {
          query: 'owner',
        },
      },
    },
    CallToolResultSchema,
  );

  assert.ok(tools.tools.some((tool) => tool.name === 'search_memory'));
  assert.ok(resources.resources.some((resource) => resource.uri === 'ci://user/context'));
  assert.ok(prompts.prompts.some((resourcePrompt) => resourcePrompt.name === 'ci_memory_usage'));
  assert.match(readTextContent(userContext.contents[0]), /currentUser/);
  assert.match(readTextContent(prompt.messages[0]?.content), /search_memory/);
  assert.match(readTextContent(toolResult.content[0]), /person-1/);

  await client.close();
  await server.close();
});
