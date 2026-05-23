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

export type ToolName =
  | 'companion_remember'
  | 'companion_recall'
  | 'companion_list'
  | 'companion_forget'
  | 'companion_context'
  | 'companion_health';

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
  ];
}
