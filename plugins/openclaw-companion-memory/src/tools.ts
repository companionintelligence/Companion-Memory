/**
 * Tool schema definitions for the Companion Intelligence OpenClaw plugin.
 *
 * These follow the OpenClaw tool-definition format (JSON Schema with
 * OpenAI-style function metadata).
 */

export interface OpenClawToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const memorySearchSchema: OpenClawToolSchema = {
  name: 'memory_search',
  description:
    "Search the user's personal memory graph for entities, events, or facts matching the " +
    'provided query. Returns a ranked list of memory entries.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: "Free-text search query, e.g. 'people I met in Boston' or 'my coffee order'.",
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results to return (default 10, max 50).',
        default: 10,
        minimum: 1,
        maximum: 50,
      },
      entity_types: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['person', 'place', 'event', 'preference', 'concept', 'organization'],
        },
        description:
          'Optional filter — only return entities of these types. ' +
          'Omit to search across all entity types.',
      },
    },
    required: ['query'],
  },
};

export const memoryGetSchema: OpenClawToolSchema = {
  name: 'memory_get',
  description:
    'Retrieve a specific memory entry by its unique identifier. ' +
    'Use when you have an ID from a previous memory_search result.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The unique identifier of the memory entry to retrieve.',
      },
    },
    required: ['id'],
  },
};

export const companionRememberSchema: OpenClawToolSchema = {
  name: 'companion_remember',
  description:
    "Explicitly store a piece of information in the user's personal memory. " +
    "Use when the user says 'remember that …' or when a salient fact should " +
    'be retained beyond the current session.',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The information to store, expressed as a natural-language statement.',
      },
      session_id: {
        type: 'string',
        description: 'The current session identifier.',
      },
      entity_type: {
        type: 'string',
        enum: ['person', 'place', 'event', 'preference', 'concept', 'organization'],
        description: 'Optional semantic type hint to improve retrieval accuracy.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Optional free-form tags for categorisation, e.g. ['work', 'travel'].",
      },
    },
    required: ['content', 'session_id'],
  },
};

/** All tool schemas exported as a convenience array. */
export const ALL_TOOL_SCHEMAS: OpenClawToolSchema[] = [
  memorySearchSchema,
  memoryGetSchema,
  companionRememberSchema,
];
