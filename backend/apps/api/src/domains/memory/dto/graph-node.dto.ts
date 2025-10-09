import type { EntityType, QueryOptions } from '../graph.types';

import type { EdgeResponseDto } from './graph-edge.dto';

export interface CreateNodeDto {
  entity_type: EntityType;
  name: string;
  description?: string;
  properties?: Record<string, unknown>;
  search_content?: string;
  linked_table?: string;
  linked_id?: string;
}

export interface UpdateNodeDto {
  name?: string;
  description?: string;
  properties?: Record<string, unknown>;
  search_content?: string;
}

export interface NodeFilterDto extends QueryOptions {
  entity_type?: EntityType;
  entity_types?: EntityType[];
  query?: string;
  linked_table?: string;
}

export interface NodeResponseDto {
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  embedding: number[] | null;
  search_content: string | null;
  linked_table: string | null;
  linked_id: string | null;
  is_active: boolean;
  is_archived: boolean;
  created_at: Date;
  updated_at: Date;
  last_accessed: Date;
  relationships?: EdgeResponseDto[];
}

export interface NodeWithRelationshipsDto extends NodeResponseDto {
  relationships: EdgeResponseDto[];
}
