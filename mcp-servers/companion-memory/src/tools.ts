import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { CompanionMemoryClient } from './client.js';

// Tool schemas — each maps 1:1 onto a backend endpoint that exists today.
// As the backend grows write surfaces (`/api/memory/turn` becoming a real
// thread+message ingest, `/api/memory/persist` for explicit stores) the
// matching tool handlers here become useful; today some of them are best
// thought of as reserved.

const RecallSchema = z.object({
  query: z.string().min(1).describe('What to recall — semantic + keyword search.'),
  maxResults: z.number().int().min(1).max(20).optional().describe('Max results (default 5).'),
});

const SearchSchema = z.object({
  query: z.string().min(1).describe('Search text against the graph.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max nodes to return (default 10).'),
});

const NodeSchema = z.object({
  entityId: z.string().uuid().describe('Entity id to fetch with neighbour traversal.'),
  maxDepth: z.number().int().min(1).max(5).optional().describe('Traversal depth (1-5).'),
  maxNodes: z.number().int().min(1).max(250).optional(),
  maxEdges: z.number().int().min(1).max(500).optional(),
});

const TurnSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      }),
    )
    .min(1)
    .describe('Conversation turns to absorb.'),
  sessionId: z.string().optional().describe('Stable id for deduplication.'),
});

const ContextSchema = z.object({});

export type ToolName =
  | 'companion_recall'
  | 'companion_context'
  | 'companion_search'
  | 'companion_node'
  | 'companion_turn';

export interface ToolDescriptor {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (client: CompanionMemoryClient, args: unknown) => Promise<unknown>;
}

export function buildToolset(): ToolDescriptor[] {
  return [
    {
      name: 'companion_recall',
      description:
        'Semantic recall against the Companion Intelligence knowledge graph. Returns a Markdown block ' +
        'pre-formatted for prompt injection (via `POST /api/memory/recall`). Best for prefetch-style flows.',
      inputSchema: zodToJsonSchema(RecallSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = RecallSchema.parse(args);

        return client.recall(input);
      },
    },
    {
      name: 'companion_context',
      description:
        'Return the current-user dossier (identity, family, top preferences, quick stats) as JSON. ' +
        'Backed by `GET /api/graph/context`.',
      inputSchema: zodToJsonSchema(ContextSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client) => {
        const context = await client.context();

        return context ?? { available: false };
      },
    },
    {
      name: 'companion_search',
      description:
        'Search the personal knowledge graph and return structured node + link results. Backed by ' +
        '`GET /api/graph/search`. Use this when you want JSON, not a Markdown block.',
      inputSchema: zodToJsonSchema(SearchSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = SearchSchema.parse(args);

        return client.search(input);
      },
    },
    {
      name: 'companion_node',
      description:
        'Fetch a single entity by id, plus its neighbours (depth ≤ 3, bounded). Backed by ' +
        '`GET /api/graph/node`. Use after companion_search to drill into a specific result.',
      inputSchema: zodToJsonSchema(NodeSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = NodeSchema.parse(args);

        return client.node(input);
      },
    },
    {
      name: 'companion_turn',
      description:
        'Sync a conversation turn into the personal database (via `POST /api/memory/turn`). The endpoint ' +
        'is reserved today and currently a no-op; calling it is safe and forward-compatible.',
      inputSchema: zodToJsonSchema(TurnSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = TurnSchema.parse(args);

        return client.turn(input);
      },
    },
  ];
}
