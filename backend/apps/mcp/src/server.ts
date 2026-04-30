import { randomUUID, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

import express, { type Request, type Response, type NextFunction } from 'express';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { CiApiClient, UpstreamApiError } from './apiClient';
import { readMcpConfig } from './config';

export interface ServerDependencies {
  apiClient: CiApiClient;
  authToken: string;
  ownerUserId?: string | null;
  version?: string;
}

interface CapabilitiesPayload {
  owner?: {
    selection?: string;
    userId?: string | null;
  };
  tools?: Array<{
    name: string;
    description: string;
  }>;
  resources?: Array<{
    uri: string;
    description: string;
  }>;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function jsonToolResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: jsonText(value),
      },
    ],
    structuredContent: value as Record<string, unknown>,
  };
}

function jsonResource(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: jsonText(value),
      },
    ],
  };
}

function createCapabilitiesMarkdown(capabilities: CapabilitiesPayload): string {
  const toolLines = (capabilities.tools ?? []).map(
    (tool: { name: string; description: string }) => `- \`${tool.name}\`: ${tool.description}`,
  );
  const resourceLines = (capabilities.resources ?? []).map(
    (resource: { uri: string; description: string }) => `- \`${resource.uri}\`: ${resource.description}`,
  );

  return [
    '# CI MCP Capabilities',
    '',
    `- Owner selection: ${capabilities.owner?.selection ?? 'unknown'}`,
    `- Owner user id: ${capabilities.owner?.userId ?? 'unavailable'}`,
    '',
    '## Use Search First',
    '- Use `search_memory` to discover ids and relevant items.',
    '- Use `read_entity_graph` when you already have an entity id or need graph structure.',
    '- Use `get_thread` for conversation history and `get_document` for file metadata/text.',
    '- Use `get_recent_activity` for a current timeline snapshot.',
    '',
    '## Tools',
    ...toolLines,
    '',
    '## Resources',
    ...resourceLines,
  ].join('\n');
}

function createPromptText() {
  return [
    'Use the CI memory MCP surface conservatively.',
    'Start with `search_memory` to discover ids.',
    'Use `read_entity_graph` only when graph structure matters.',
    'Prefer resources for stable snapshots like owner context and capabilities.',
  ].join(' ');
}

const searchMemorySchema: Record<string, z.ZodTypeAny> = {
  query: z.string().min(1).max(500),
  searchMode: z.enum(['semantic', 'keyword', 'hybrid', 'auto']).optional(),
  entityTypes: z.array(z.string()).optional(),
  maxResults: z.number().int().min(1).max(25).optional(),
};

const readEntityGraphSchema: Record<string, z.ZodTypeAny> = {
  entityId: z.string().uuid().optional(),
  useCurrentUser: z.boolean().optional(),
  filters: z
    .object({
      entityType: z.string().optional(),
      nameContains: z.string().optional(),
      propertyEquals: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      limit: z.number().int().min(1).max(25).optional(),
    })
    .optional(),
  relationshipTypes: z.array(z.string()).optional(),
  direction: z.enum(['outbound', 'inbound', 'both']).optional(),
  maxDepth: z.number().int().min(0).max(2).optional(),
  maxNodes: z.number().int().min(1).max(50).optional(),
  maxEdges: z.number().int().min(1).max(100).optional(),
  includeProperties: z.boolean().optional(),
};

const recentActivitySchema: Record<string, z.ZodTypeAny> = {
  limit: z.number().int().min(1).max(25).optional(),
  since: z.string().datetime().optional(),
};

const getThreadSchema: Record<string, z.ZodTypeAny> = {
  threadId: z.string().uuid(),
  maxMessages: z.number().int().min(1).max(100).optional(),
};

const getDocumentSchema: Record<string, z.ZodTypeAny> = {
  documentId: z.string().uuid(),
  includeText: z.boolean().optional(),
  maxChars: z.number().int().min(250).max(20000).optional(),
};

export function createMcpServer(apiClient: CiApiClient, version: string) {
  const server = new McpServer(
    {
      name: 'ci-mcp',
      version,
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );
  const registerTool = server.tool.bind(server) as unknown as (...args: unknown[]) => void;

  registerTool(
    'search_memory',
    'Search indexed personal memory with bounded results.',
    searchMemorySchema,
    async (args: Record<string, unknown>) => jsonToolResult(await apiClient.searchMemory(args)),
  );

  registerTool(
    'read_entity_graph',
    'Read a bounded graph neighborhood for the current owner or a specific entity id.',
    readEntityGraphSchema,
    async (args: Record<string, unknown>) => jsonToolResult(await apiClient.readEntityGraph(args)),
  );

  registerTool('get_user_context', 'Get the current owner user context snapshot.', async () =>
    jsonToolResult(await apiClient.getUserContext()),
  );

  registerTool(
    'get_recent_activity',
    'Get recent summaries, actions, and timeline activity.',
    recentActivitySchema,
    async (args: Record<string, unknown>) => jsonToolResult(await apiClient.getRecentActivity(args)),
  );

  registerTool(
    'get_thread',
    'Read one conversation thread with recent messages.',
    getThreadSchema,
    async (args: Record<string, unknown>) =>
      jsonToolResult(
        await apiClient.getThread(String(args.threadId), args.maxMessages as number | undefined),
      ),
  );

  registerTool(
    'get_document',
    'Read file metadata and inline text when directly available.',
    getDocumentSchema,
    async (args: Record<string, unknown>) =>
      jsonToolResult(
        await apiClient.getDocument(
          String(args.documentId),
          args.includeText as boolean | undefined,
          args.maxChars as number | undefined,
        ),
      ),
  );

  server.resource(
    'capabilities-overview',
    'ci://capabilities/overview',
    {
      description: 'Overview of the external CI memory MCP surface.',
      mimeType: 'text/markdown',
    },
    async () => {
      const capabilities = await apiClient.getCapabilities();

      return {
        contents: [
          {
            uri: 'ci://capabilities/overview',
            mimeType: 'text/markdown',
            text: createCapabilitiesMarkdown(capabilities),
          },
        ],
      };
    },
  );

  server.resource(
    'user-context',
    'ci://user/context',
    {
      description: 'Owner user context snapshot.',
      mimeType: 'application/json',
    },
    async () => {
      const payload = await apiClient.getUserContext();

      return jsonResource('ci://user/context', payload);
    },
  );

  server.resource(
    'graphql-summary',
    'ci://schema/graphql-summary',
    {
      description: 'Summary of the internal GraphQL schema.',
      mimeType: 'application/json',
    },
    async () => {
      const capabilities = await apiClient.getCapabilities();

      return jsonResource('ci://schema/graphql-summary', capabilities.graphql);
    },
  );

  server.resource(
    'entity-resource',
    new ResourceTemplate('ci://entities/{entityId}', {
      list: undefined,
    }),
    {
      description: 'Bounded graph view for a single entity id.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const entityId = uri.pathname.replace(/^\//, '');

      return jsonResource(
        uri.toString(),
        await apiClient.readEntityGraph({ entityId, includeProperties: true }),
      );
    },
  );

  server.resource(
    'thread-resource',
    new ResourceTemplate('ci://threads/{threadId}', {
      list: undefined,
    }),
    {
      description: 'Thread metadata and recent messages.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const threadId = uri.pathname.replace(/^\//, '');

      return jsonResource(uri.toString(), await apiClient.getThread(threadId));
    },
  );

  server.prompt('ci_memory_usage', 'Guide for using the CI memory MCP surface', async () => ({
    description: 'Best-practice guidance for using the CI memory tools and resources.',
    messages: [
      {
        role: 'assistant',
        content: {
          type: 'text',
          text: createPromptText(),
        },
      },
    ],
  }));

  return server;
}

export function authMatches(expectedToken: string, authHeader: string | undefined): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const providedToken = authHeader.slice('Bearer '.length);
  const expected = Buffer.from(expectedToken, 'utf8');
  const provided = Buffer.from(providedToken, 'utf8');

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

export function createApp(dependencies: ServerDependencies) {
  const app = express();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', async (_req, res) => {
    try {
      const capabilities = (await dependencies.apiClient.getCapabilities()) as {
        owner?: {
          userId: string | null;
          selection: string;
        };
      };

      res.status(200).json({
        status: 'ok',
        owner: capabilities.owner ?? null,
        configuredOwnerUserId: dependencies.ownerUserId ?? null,
      });
    } catch (error) {
      res.status(503).json({
        status: 'degraded',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (!authMatches(dependencies.authToken, req.header('Authorization'))) {
      res.status(401).json({
        error: 'Unauthorized',
      });

      return;
    }

    next();
  };

  app.all('/mcp', authMiddleware, async (req: Request, res: Response) => {
    try {
      if (req.method === 'GET') {
        res.status(405).set('Allow', 'POST, DELETE').send('Method Not Allowed');

        return;
      }

      const sessionId = req.header('Mcp-Session-Id');
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport && req.method === 'POST' && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (createdSessionId) => {
            transports.set(createdSessionId, transport!);
          },
          onsessionclosed: (closedSessionId) => {
            transports.delete(closedSessionId);
          },
        });

        const server = createMcpServer(dependencies.apiClient, dependencies.version ?? '0.0.0');

        await server.connect(transport);
        await transport.handleRequest(req as IncomingMessage, res as unknown as ServerResponse, req.body);

        return;
      }

      if (!transport) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid MCP session found',
          },
          id: null,
        });

        return;
      }

      await transport.handleRequest(req as IncomingMessage, res as unknown as ServerResponse, req.body);
    } catch (error) {
      if (error instanceof UpstreamApiError) {
        res.status(error.status >= 500 ? 502 : error.status).json({
          error: error.body,
        });

        return;
      }

      if (!res.headersSent) {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  return app;
}

export function createDefaultApp() {
  const mcpConfig = readMcpConfig();

  return createApp({
    apiClient: new CiApiClient({
      baseUrl: mcpConfig.CI_API_BASE_URL,
      serviceKey: mcpConfig.CI_API_SERVICE_KEY,
    }),
    authToken: mcpConfig.CI_MCP_AUTH_TOKEN,
    ownerUserId: mcpConfig.CI_OWNER_USER_ID,
  });
}
