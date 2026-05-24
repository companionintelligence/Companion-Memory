import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { CompanionMemoryClient, type MemoryRecord } from './client.js';

const RememberSchema = z.object({
  content: z.string().min(1).describe('The natural-language content to store as a memory.'),
  name: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('Optional display name. Defaults to first line of content.'),
  entityType: z.string().min(1).optional().describe('Graph entity type. Defaults to "Concept".'),
  tags: z.array(z.string().min(1)).max(32).optional().describe('Tags for filtering during recall.'),
  metadata: z.record(z.unknown()).optional().describe('Arbitrary key/value metadata stored on the memory.'),
  source: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('Where this memory came from (e.g. "claude-code", "hermes").'),
});

const RecallSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Search text. Hybrid full-text + prefix search runs across all memories.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results. Default 10.'),
  entityType: z
    .string()
    .min(1)
    .optional()
    .describe('Restrict to a specific entity type, e.g. "Person" or "Concept".'),
});

const ListSchema = z.object({
  entityType: z.string().min(1).optional(),
  nameContains: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const ForgetSchema = z.object({
  id: z.string().uuid().describe('Memory id returned from remember/recall/list.'),
  reason: z.string().min(1).max(512).optional(),
  hardDelete: z.boolean().optional().describe('Permanently delete instead of archiving. Default false.'),
});

const ContextSchema = z.object({});

const HealthSchema = z.object({});

const CiSearchSchema = z.object({
  query: z.string().min(1).describe('What to search for in the knowledge graph.'),
  maxResults: z.number().int().min(1).max(20).optional().describe('Max results (default 5).'),
});

const CiQuerySchema = z.object({
  query: z.string().min(1).describe('Deep query against the knowledge graph (richer than ci_search).'),
  entityType: z
    .enum(['person', 'place', 'event', 'concept', 'content', 'communication', 'item', 'note', 'file'])
    .optional()
    .describe('Optional — restrict to a single entity type.'),
  maxResults: z.number().int().min(1).max(20).optional().describe('Max results (default 10).'),
});

const CiRememberSchema = z.object({
  content: z.string().min(1).describe('Fact or observation to store.'),
  name: z.string().min(1).max(255).optional().describe('Short label for the entry.'),
});

const AgentRecallSchema = z.object({
  query: z.string().min(1).describe('Text to recall on. Returns a Markdown block capped at ~3k chars.'),
  maxResults: z.number().int().min(1).max(20).optional().describe('Max results (default 5).'),
});

const AgentAbsorbSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      }),
    )
    .min(1)
    .describe('Conversation turns to ingest into the knowledge graph.'),
  sessionId: z
    .string()
    .optional()
    .describe('Stable id for upsert dedup (one Communication row per session).'),
  platform: z.string().optional().describe('Originating platform (e.g. "hermes", "claude-code").'),
});

const AgentContextSchema = z.object({});

export type ToolName =
  | 'companion_remember'
  | 'companion_recall'
  | 'companion_list'
  | 'companion_forget'
  | 'companion_context'
  | 'companion_health'
  | 'ci_search'
  | 'ci_query'
  | 'ci_remember'
  | 'agent_context'
  | 'agent_recall'
  | 'agent_absorb';

export interface ToolDescriptor {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (client: CompanionMemoryClient, args: unknown) => Promise<unknown>;
}

const formatMemory = (memory: MemoryRecord): MemoryRecord => memory;

export function buildToolset(): ToolDescriptor[] {
  return [
    {
      name: 'companion_remember',
      description:
        'Store a memory in the Companion Intelligence knowledge graph. Use for facts, preferences, decisions, ' +
        'and any information that should persist across sessions. Returns the created memory record.',
      inputSchema: zodToJsonSchema(RememberSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = RememberSchema.parse(args);

        return formatMemory(await client.remember(input));
      },
    },
    {
      name: 'companion_recall',
      description:
        'Search the Companion Intelligence knowledge graph and return the most relevant memories. ' +
        'Hybrid full-text + prefix search.',
      inputSchema: zodToJsonSchema(RecallSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = RecallSchema.parse(args);
        const results = await client.recall(input);

        return { query: input.query, count: results.length, results };
      },
    },
    {
      name: 'companion_list',
      description: 'List memories with optional filters by entity type or name substring.',
      inputSchema: zodToJsonSchema(ListSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = ListSchema.parse(args);
        const results = await client.list(input);

        return { count: results.length, results };
      },
    },
    {
      name: 'companion_forget',
      description:
        'Forget a memory by id. Defaults to archive mode (recoverable); set hardDelete=true to remove permanently.',
      inputSchema: zodToJsonSchema(ForgetSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = ForgetSchema.parse(args);

        return client.forget(input);
      },
    },
    {
      name: 'companion_context',
      description:
        'Return the current-user context snapshot used to pre-hydrate LLM system prompts: identity, family, ' +
        'top preferences, and quick stats.',
      inputSchema: zodToJsonSchema(ContextSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client) => {
        const context = await client.context();

        return context ?? { available: false };
      },
    },
    {
      name: 'companion_health',
      description: 'Health-check the companion-memory backend.',
      inputSchema: zodToJsonSchema(HealthSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client) => client.health(),
    },
    // -------------------------------------------------------------------------
    // Agent-surface tools — bridge to /api/agent/* on the backend (added by the
    // feature/agent-memory branch). These return Markdown blocks pre-formatted
    // for prompt injection, with a built-in token-budget cap.
    // -------------------------------------------------------------------------
    {
      name: 'ci_search',
      description:
        'Quick semantic lookup against the Companion Intelligence knowledge graph. ' +
        'Returns a Markdown-formatted block of relevant entities.',
      inputSchema: zodToJsonSchema(CiSearchSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = CiSearchSchema.parse(args);

        return client.agentTool({ tool: 'ci_search', args: input });
      },
    },
    {
      name: 'ci_query',
      description:
        'Deep query against the knowledge graph. Traverses relationships and returns structured detail. ' +
        'Use when ci_search results are insufficient.',
      inputSchema: zodToJsonSchema(CiQuerySchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = CiQuerySchema.parse(args);

        return client.agentTool({ tool: 'ci_query', args: input });
      },
    },
    {
      name: 'ci_remember',
      description: 'Store a new fact or observation about the user in the knowledge graph.',
      inputSchema: zodToJsonSchema(CiRememberSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = CiRememberSchema.parse(args);

        return client.agentTool({ tool: 'ci_remember', args: input });
      },
    },
    {
      name: 'agent_context',
      description:
        'Return the L0 static user dossier as a pre-formatted Markdown block ready for prompt injection. ' +
        'Cheaper than companion_context (which returns structured JSON) when you only need the block.',
      inputSchema: zodToJsonSchema(AgentContextSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client) => ({ block: await client.agentContext() }),
    },
    {
      name: 'agent_recall',
      description:
        'Run an L1 semantic recall and return a Markdown block (capped at ~3k chars) ready for prompt ' +
        'injection. Intended for Hermes `prefetch`-style flows.',
      inputSchema: zodToJsonSchema(AgentRecallSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = AgentRecallSchema.parse(args);

        return client.agentRecall(input);
      },
    },
    {
      name: 'agent_absorb',
      description:
        'Ingest conversation turns into the knowledge graph as a Communication row (upsert by sessionId). ' +
        'Intended for Hermes `sync_turn`-style flows. Returns {ok: true} on success.',
      inputSchema: zodToJsonSchema(AgentAbsorbSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
      handler: async (client, args) => {
        const input = AgentAbsorbSchema.parse(args);

        return client.agentAbsorb(input);
      },
    },
  ];
}
