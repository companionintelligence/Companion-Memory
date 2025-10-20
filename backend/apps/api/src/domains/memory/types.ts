import type { Point } from 'typeorm';

export interface Memory {
  id: string;
  type: string;
  title: string;
  description: string | null;
  timestamp: Date;
  category: string;
  location?: MemoryLocation;
  tags: string[];
  userId: string;
  sourceLink?: string;
  metadata?: {
    eventId?: string;
    eventType?: string;
    eventName?: string;
    synthetic?: boolean;
    personRef?: string;
    contentRef?: string;
    thingRef?: string;
    entityType?: string;
    communicationType?: string;
    direction?: string;
    participantsMetadata?: unknown;
    relationships?: Array<{
      type: string;
      targetId: string;
      targetName: string;
      targetType: string;
      direction: 'outgoing' | 'incoming';
    }>;
    [key: string]: unknown;
  };
}

export interface MemoryLocation {
  id: string;
  name: string | null;
  lat: number;
  lng: number;
  address?: string;
  placeId?: string;
}

export interface MemorySearchParams {
  query?: string;
  startDate?: Date;
  endDate?: Date;
  categories?: string[];
  excludeCategories?: string[];
  hasLocation?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryResponse {
  data: Memory[];
  total: number;
  limit: number;
  offset: number;
}

export interface Event {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly event_type: string | null;
  readonly category: string | null;
  readonly start_time: Date;
  readonly end_time: Date | null;
  readonly duration_minutes: number | null;
  readonly location_name: string | null;
  readonly location_coordinates: Point | null;
  readonly event_entity_id: string | null;
  readonly location_entity_id: string | null;
  readonly participant_entity_ids: string[] | null;
  readonly organizer_entity_id: string | null;
  readonly source_type: string | null;
  readonly source_system: string | null;
  readonly source_id: string | null;
  readonly confidence_score: number;
  readonly is_recurring: boolean;
  readonly recurrence_pattern: object | null;
  readonly is_all_day: boolean;
  readonly is_private: boolean;
  readonly priority: number;
  readonly metadata: object;
  readonly is_predicted: boolean;
  readonly is_inferred: boolean;
  readonly prediction_model: string | null;
  readonly inference_sources: object;
  readonly tags: string[] | null;
  readonly sentiment_score: number | null;
  readonly energy_level: number | null;
  readonly productivity_impact: number | null;
  readonly status: string;
  readonly is_deleted: boolean;
  readonly external_sync_status: string | null;
  readonly last_synced_at: Date | null;
  readonly parent_event_id: string | null;
  readonly related_event_ids: string[] | null;
  readonly supersedes_event_id: string | null;
  readonly created_by: string | null;
  readonly user_id: string | undefined;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface CreateEventDto {
  id: string;
  title: string;
  description?: string;
  event_type?: string;
  category?: string;
  start_time: Date;
  end_time?: Date;
  location_name?: string;
  event_entity_id?: string;
  location_entity_id?: string;
  location_coordinates?: Point;
  participant_entity_ids?: string[];
  organizer_entity_id?: string;
  source_type?: string;
  source_system?: string;
  source_id?: string;
  confidence_score?: number;
  is_recurring?: boolean;
  recurrence_pattern?: object;
  is_all_day?: boolean;
  is_private?: boolean;
  priority?: number;
  metadata?: object;
  is_predicted?: boolean;
  is_inferred?: boolean;
  prediction_model?: string;
  inference_sources?: object;
  tags?: string[];
  sentiment_score?: number;
  energy_level?: number;
  productivity_impact?: number;
  status?: string;
  is_deleted?: boolean;
  external_sync_status?: string;
  last_synced_at?: Date;
  parent_event_id?: string;
  related_event_ids?: string[];
  supersedes_event_id?: string;
  created_by?: string;
  user_id?: string;
  user?: {
    id: string;
  };
  content?: CreateContentDto[];
}

export interface UpdateEventDto {
  id?: string;
  title?: string;
  description?: string;
  event_type?: string;
  category?: string;
  start_time?: Date;
  end_time?: Date;
  location_name?: string;
  event_entity_id?: string;
  location_entity_id?: string;
  location_coordinates?: Point;
  participant_entity_ids?: string[];
  organizer_entity_id?: string;
  source_type?: string;
  source_system?: string;
  source_id?: string;
  confidence_score?: number;
  is_recurring?: boolean;
  recurrence_pattern?: object;
  is_all_day?: boolean;
  is_private?: boolean;
  priority?: number;
  metadata?: object;
  is_predicted?: boolean;
  is_inferred?: boolean;
  prediction_model?: string;
  inference_sources?: object;
  tags?: string[];
  sentiment_score?: number;
  energy_level?: number;
  productivity_impact?: number;
  status?: string;
  is_deleted?: boolean;
  external_sync_status?: string;
  last_synced_at?: Date;
  parent_event_id?: string;
  related_event_ids?: string[];
  supersedes_event_id?: string;
  created_by?: string;
  user_id?: string;
  content?: CreateContentDto[];
}

export interface Content {
  readonly id: string;
  readonly type: string;
  readonly title: string | null;
  readonly text: string | null;
  readonly url: string | null;
  readonly mimetype: string | null;
  readonly external_id: string | null;
  readonly source_url: string | null;
  readonly user_id: string | null;
  readonly event_id: string | null;
}

export interface CreateContentDto {
  id: string;
  type: string;
  title?: string;
  text?: string;
  url?: string;
  mimetype?: string;
  external_id?: string;
  source_url?: string;
  user_id?: string;
  event_id: string;
  event?: {
    id: string;
  };
  user?: {
    id: string;
  };
}

export interface UpdateContentDto {
  type?: string;
  title?: string;
  text?: string;
  url?: string;
  mimetype?: string;
  external_id?: string;
  source_url?: string;
  event?: {
    id: string;
  };
  user?: {
    id: string;
  };
}
