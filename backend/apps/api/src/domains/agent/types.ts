import { z } from 'zod';

import { INDEXABLE_ENTITIES } from '@ci/domains/search-next';

export const agentSearchSchema = z.object({
  query: z.string().min(1).max(500),
  searchMode: z.enum(['semantic', 'keyword', 'hybrid', 'auto']).optional(),
  entityTypes: z.array(z.enum(INDEXABLE_ENTITIES)).optional(),
  maxResults: z.coerce.number().int().min(1).max(25).optional().default(10),
});

export const agentGraphReadSchema = z
  .object({
    entityId: z.string().uuid().optional(),
    useCurrentUser: z.boolean().optional().default(true),
    filters: z
      .object({
        entityType: z.string().min(1).optional(),
        nameContains: z.string().min(1).optional(),
        propertyEquals: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        limit: z.coerce.number().int().min(1).max(25).optional(),
      })
      .optional(),
    relationshipTypes: z.array(z.string().min(1)).optional(),
    direction: z.enum(['outbound', 'inbound', 'both']).optional().default('both'),
    maxDepth: z.coerce.number().int().min(0).max(2).optional().default(1),
    maxNodes: z.coerce.number().int().min(1).max(50).optional().default(25),
    maxEdges: z.coerce.number().int().min(1).max(100).optional().default(50),
    includeProperties: z.boolean().optional().default(false),
  })
  .refine((value) => value.entityId || value.useCurrentUser || value.filters, {
    message: 'Provide entityId, useCurrentUser, or filters',
  });

export const agentRecentActivitySchema = z.object({
  limit: z.coerce.number().int().min(1).max(25).optional().default(10),
  since: z.string().datetime().optional(),
});

export const agentThreadQuerySchema = z.object({
  maxMessages: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const agentDocumentQuerySchema = z.object({
  includeText: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value !== 'false'),
  maxChars: z.coerce.number().int().min(250).max(20000).optional().default(4000),
});

export interface AgentEntitySummary {
  id: string;
  type: string;
  title: string | null;
  summary: string | null;
  timestamp: string | null;
  url?: string | null;
  attributes?: Record<string, unknown>;
}

export interface AgentGraphNode {
  id: string;
  entityType: string;
  name: string | null;
  description: string | null;
  properties?: Record<string, unknown>;
}

export interface AgentGraphEdge {
  id: string;
  relationshipType: string;
  source: string;
  target: string;
  strength: number;
  bidirectional: boolean;
  properties?: Record<string, unknown>;
}

export interface AgentThreadMessage {
  id: string;
  role: string;
  content: string;
  mimetype: string | null;
  createdAt: string;
  toolCalls: Record<string, unknown>[] | null;
  files: Array<{
    id: string;
    filename: string | null;
    contentType: string;
    url: string | null;
  }>;
}

export interface AgentDocumentPayload {
  id: string;
  filename: string | null;
  title: string | null;
  description: string | null;
  contentType: string;
  size: number | null;
  sourceUrl: string | null;
  previewUrl: string | null;
  createdAt: string;
  updatedAt: string;
  text: string | null;
  textTruncated: boolean;
}

export interface AgentCapabilities {
  owner: {
    userId: string | null;
    selection: 'configured' | 'unavailable';
  };
  tools: Array<{
    name: string;
    description: string;
  }>;
  resources: Array<{
    uri: string;
    description: string;
  }>;
  graphql: {
    queryCount: number;
    mutationCount: number;
    queries: string[];
    mutations: string[];
  };
}

export type AgentSearchInput = z.infer<typeof agentSearchSchema>;
export type AgentGraphReadInput = z.infer<typeof agentGraphReadSchema>;
export type AgentRecentActivityInput = z.infer<typeof agentRecentActivitySchema>;
export type AgentThreadQuery = z.infer<typeof agentThreadQuerySchema>;
export type AgentDocumentQuery = z.infer<typeof agentDocumentQuerySchema>;
