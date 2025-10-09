import { z } from 'zod';

import { ENTITY_TYPES, RELATIONSHIP_TYPES } from '../graph.types';

// Node/Entity Schemas
export const createNodeSchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  properties: z.record(z.unknown()).default({}),
  search_content: z.string().optional(),
  linked_table: z.string().optional(),
  linked_id: z.string().uuid().optional(),
});

export const updateNodeSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
  search_content: z.string().optional(),
});

export const nodeFilterSchema = z.object({
  entity_type: z.enum(ENTITY_TYPES).optional(),
  entity_types: z.array(z.enum(ENTITY_TYPES)).optional(),
  query: z.string().optional(),
  linked_table: z.string().optional(),
  orderBy: z.string().default('created_at'),
  sortOrder: z.enum(['ASC', 'DESC']).default('DESC'),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
});

// Edge/Relationship Schemas
export const createEdgeSchema = z.object({
  from_entity_id: z.string().uuid('Invalid from_entity_id format'),
  to_entity_id: z.string().uuid('Invalid to_entity_id format'),
  relationship_type: z.enum(RELATIONSHIP_TYPES),
  strength: z.number().min(0).max(1).default(1.0),
  properties: z.record(z.unknown()).default({}),
  is_bidirectional: z.boolean().default(false),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
});

export const updateEdgeSchema = z.object({
  relationship_type: z.enum(RELATIONSHIP_TYPES).optional(),
  strength: z.number().min(0).max(1).optional(),
  properties: z.record(z.unknown()).optional(),
  is_bidirectional: z.boolean().optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
});

export const edgeFilterSchema = z.object({
  from_entity_id: z.string().uuid().optional(),
  to_entity_id: z.string().uuid().optional(),
  relationship_type: z.enum(RELATIONSHIP_TYPES).optional(),
  relationship_types: z.array(z.enum(RELATIONSHIP_TYPES)).optional(),
  min_strength: z.number().min(0).max(1).optional(),
  orderBy: z.string().default('created_at'),
  sortOrder: z.enum(['ASC', 'DESC']).default('DESC'),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
});

export const relationshipLoadOptionsSchema = z.object({
  loadRelationships: z.boolean().default(false),
  relationshipTypes: z.array(z.string()).optional(),
  direction: z.enum(['inbound', 'outbound', 'both']).default('both'),
  maxDepth: z.number().int().min(1).max(5).default(1),
});

export type CreateNodeInput = z.infer<typeof createNodeSchema>;
export type UpdateNodeInput = z.infer<typeof updateNodeSchema>;
export type NodeFilterInput = z.infer<typeof nodeFilterSchema>;
export type CreateEdgeInput = z.infer<typeof createEdgeSchema>;
export type UpdateEdgeInput = z.infer<typeof updateEdgeSchema>;
export type EdgeFilterInput = z.infer<typeof edgeFilterSchema>;
export type RelationshipLoadOptionsInput = z.infer<typeof relationshipLoadOptionsSchema>;
