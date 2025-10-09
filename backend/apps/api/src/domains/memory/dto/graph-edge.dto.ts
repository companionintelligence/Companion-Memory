import type { RelationshipType, QueryOptions } from '../graph.types';

import type { NodeResponseDto } from './graph-node.dto';

export interface CreateEdgeDto {
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: RelationshipType;
  strength?: number;
  properties?: Record<string, unknown>;
  is_bidirectional?: boolean;
  start_date?: string;
  end_date?: string;
}

export interface UpdateEdgeDto {
  relationship_type?: RelationshipType;
  strength?: number;
  properties?: Record<string, unknown>;
  is_bidirectional?: boolean;
  start_date?: string;
  end_date?: string;
}

export interface EdgeFilterDto extends QueryOptions {
  from_entity_id?: string;
  to_entity_id?: string;
  relationship_type?: RelationshipType;
  relationship_types?: RelationshipType[];
  min_strength?: number;
}

export interface EdgeResponseDto {
  relationship_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  strength: number;
  properties: Record<string, unknown>;
  is_bidirectional: boolean;
  is_active: boolean;
  start_date: Date | null;
  end_date: Date | null;
  created_at: Date;
  updated_at: Date;
  from_entity?: NodeResponseDto;
  to_entity?: NodeResponseDto;
}
