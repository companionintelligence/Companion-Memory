import { z } from 'zod';

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

export const recallSchema = z.object({
  query: z.string().min(1).max(2000),
  maxResults: z.number().int().min(1).max(20).optional(),
});

export const absorbSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      }),
    )
    .min(1),
  sessionId: z.string().optional(),
  platform: z.string().optional(),
});

export const toolCallSchema = z.object({
  tool: z.enum(['ci_search', 'ci_query', 'ci_remember']),
  args: z.record(z.unknown()),
});

export type RecallDto = z.infer<typeof recallSchema>;
export type AbsorbDto = z.infer<typeof absorbSchema>;
export type ToolCallDto = z.infer<typeof toolCallSchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface ContextResult {
  block: string;
}

export interface RecallResult {
  block: string;
  resultCount: number;
}

export interface AbsorbResult {
  ok: boolean;
}

export interface ToolResult {
  result: unknown;
}

// ---------------------------------------------------------------------------
// Tool schemas exposed to Hermes
// ---------------------------------------------------------------------------

export const CI_TOOL_SCHEMAS = [
  {
    name: 'ci_search',
    description:
      'Search your Companion Intelligence knowledge graph for relevant people, places, events, ' +
      'concepts, and content. Use for quick semantic lookups.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        maxResults: { type: 'integer', description: 'Max results to return (default 5, max 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ci_query',
    description:
      'Deep query of your Companion Intelligence knowledge graph. Traverses relationships and returns ' +
      'richer detail than ci_search. Use when ci_search results are insufficient.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        entityType: {
          type: 'string',
          enum: ['person', 'place', 'event', 'concept', 'content', 'communication', 'item', 'note', 'file'],
          description: 'Optional — restrict to this entity type.',
        },
        maxResults: { type: 'integer', description: 'Max results (default 10, max 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ci_remember',
    description:
      'Store a new fact or observation about the user in their Companion Intelligence knowledge graph.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact or observation to store.' },
        name: { type: 'string', description: 'Short label for this entry (optional).' },
      },
      required: ['content'],
    },
  },
];
