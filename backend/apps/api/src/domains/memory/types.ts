import type { Point } from 'typeorm';
import { z } from 'zod';

export const createContentSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
  mimetype: z.string().optional(),
  external_id: z.string().optional(),
  source_url: z.string().optional(),
  user_id: z.string().optional(),
  event_id: z.string().optional(),
});

export const updateContentSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
  mimetype: z.string().optional(),
  external_id: z.string().optional(),
  source_url: z.string().optional(),
  user_id: z.string().optional(),
  event_id: z.string().optional(),
});

export interface CreateEventDto {
  id?: string;
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
  recurrence_pattern?: Record<string, unknown>;
  is_all_day?: boolean;
  is_private?: boolean;
  priority?: number;
  metadata?: Record<string, unknown>;
  is_predicted?: boolean;
  is_inferred?: boolean;
  prediction_model?: string;
  inference_sources?: Record<string, unknown>;
  tags?: string[];
  sentiment_score?: number;
  energy_level?: number;
  productivity_impact?: number;
  status?: string;
  sharing_level?: string;
  is_deleted?: boolean;
  external_sync_status?: string;
  last_synced_at?: Date;
  parent_event_id?: string;
  related_event_ids?: string[];
  supersedes_event_id?: string;
  created_by?: string;
  user_id?: string;
  duration_minutes?: number;
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
  recurrence_pattern?: Record<string, unknown>;
  is_all_day?: boolean;
  is_private?: boolean;
  priority?: number;
  metadata?: Record<string, unknown>;
  is_predicted?: boolean;
  is_inferred?: boolean;
  prediction_model?: string;
  inference_sources?: Record<string, unknown>;
  tags?: string[];
  sentiment_score?: number;
  energy_level?: number;
  productivity_impact?: number;
  status?: string;
  sharing_level?: string;
  is_deleted?: boolean;
  external_sync_status?: string;
  last_synced_at?: Date;
  parent_event_id?: string;
  related_event_ids?: string[];
  supersedes_event_id?: string;
  created_by?: string;
  user_id?: string;
  duration_minutes?: number;
  content?: CreateContentDto[];
}

export interface SearchEventDto {
  id?: string;
  title?: string;
  description?: string;
  eventType?: string;
  category?: string;
  startTime?: Date;
  endTime?: Date;
  locationName?: string;
  eventEntityId?: string;
  locationEntityId?: string;
  locationCoordinates?: Point;
  organizerEntityId?: string;
  sourceType?: string;
  sourceSystem?: string;
  sourceId?: string;
  confidenceScore?: number;
  isRecurring?: boolean;
  recurrencePattern?: object;
  isAllDay?: boolean;
  isPrivate?: boolean;
  priority?: number;
  metadata?: object;
  isPredicted?: boolean;
  isInferred?: boolean;
  predictionModel?: string;
  inferenceSources?: object;
  sentimentScore?: number;
  energyLevel?: number;
  productivityImpact?: number;
  status?: string;
  isDeleted?: boolean;
  externalSyncStatus?: string;
  lastSyncedAt?: Date | undefined;
  parentEventId?: string;
  supersedesEventId?: string;
  createdBy?: string;
  userId?: string;
}

export interface CreateContentDto {
  id?: string;
  type: string;
  title?: string;
  text?: string;
  url?: string;
  mimetype?: string;
  external_id?: string;
  source_url?: string;
  source_data?: Record<string, unknown>;
  user_id?: string;
  event_id?: string;
  // Provenance triple for idempotent batch ingest and event auto-linking. See
  // content_source_triple_uniq and ContentService.createMany.
  source_type?: string;
  source_system?: string;
  source_id?: string;
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
  source_data?: Record<string, unknown>;
  event?: {
    id: string;
  };
  user?: {
    id: string;
  };
}

export type SearchContentDto = UpdateContentDto;

export interface CreatePlaceDto {
  id?: string;
  entity_type?: string;
  name?: string;
  description?: string;
  properties?: Record<string, unknown>;
  type?: string;
  geo_format?: string;
  geolocation?: Record<string, unknown>;
  location_boundary?: Record<string, unknown>;
  estimated?: boolean;
  tracked?: boolean;
  uploaded?: boolean;
  user_id?: string;
  user?: {
    id: string;
  };
  parent?: {
    id: string;
  };
}

export interface UpdatePlaceDto {
  entity_type?: string;
  name?: string;
  description?: string;
  properties: {
    type?: string;
    geoformat?: string;
    geolocation?: Record<string, unknown>;
    locationBoundary?: Record<string, unknown>;
    estimated?: boolean;
    tracked?: boolean;
    uploaded?: boolean;
    [key: string]: unknown;
  };
  user_id?: string;
  parent?: {
    id: string;
  };
}

export interface CreateFileDto {
  name?: string;
  description?: string;
  properties?: Record<string, unknown>;
  linkedId?: string;
  user?: {
    id: string;
  };
}

export interface CreateItemDto {
  id?: string;
  name: string;
  description?: string;
  category?: string;
  subcategory?: string;
  brand?: string;
  model?: string;
  purchasePrice?: number;
  currentValue?: number;
  currency?: string;
  acquiredAt?: Date;
  identifierCodes?: Record<string, unknown>;
  condition?: 'new' | 'like_new' | 'good' | 'fair' | 'poor' | 'broken' | 'n/a' | null;
  images?: string[];
  metadata?: Record<string, unknown>;
  // Provenance triple for idempotent re-ingest (see inventory_source_triple_uniq).
  sourceType?: string;
  sourceSystem?: string;
  sourceId?: string;
}

export interface UpdateItemDto {
  name?: string;
  description?: string;
  category?: string;
  subcategory?: string;
  brand?: string;
  model?: string;
  currentValue?: number;
  currency?: string;
  condition?: 'new' | 'like_new' | 'good' | 'fair' | 'poor' | 'broken' | 'n/a' | null;
  images?: string[];
  metadata?: Record<string, unknown> | undefined;
}

export interface CreatePersonDto {
  id?: string;
  name?: string;
  description?: string;
  searchContent?: string;
  linkedId?: string;
  linkedTable?: string;
  lastAccessed?: Date;
  properties?: {
    email?: string;
    firstName?: string;
    lastName?: string;
    contactType?: string;
    ownerUserId?: string;
    connectionId?: string;
    sources?: string[];
    [key: string]: unknown;
  };
}

export interface UpdatePersonDto {
  name?: string;
  description?: string;
  searchContent?: string;
  linkedId?: string;
  linkedTable?: string;
  lastAccessed?: Date;
  properties?: {
    email?: string;
    firstName?: string;
    lastName?: string;
    contactType?: string;
    ownerUserId?: string;
    connectionId?: string;
    sources?: string[];
    [key: string]: unknown;
  };
}

export interface CreateConceptDto {
  id?: string;
  name?: string;
  description?: string;
  searchContent?: string;
  linkedId?: string | null;
  linkedTable?: string | null;
  lastAccessed?: Date;
  properties?: Record<string, unknown>;
}

export interface UpdateConceptDto {
  name?: string;
  description?: string;
  searchContent?: string;
  linkedId?: string | null;
  linkedTable?: string | null;
  lastAccessed?: Date;
  properties?: Record<string, unknown>;
}

export enum CommunicationType {
  EMAIL = 'email',
  SMS = 'sms',
  CALL = 'call',
  CHAT = 'chat',
  VIDEO_CALL = 'video_call',
  VOICE_NOTE = 'voice_note',
  POST = 'post',
}

export enum CommunicationDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
  INTERNAL = 'internal',
  ASYNC = 'async',
  ONGOING = 'ongoing',
}
export interface CreateCommunicationDto {
  id?: string;
  time: Date;
  communication_type: CommunicationType;
  direction: 'inbound' | 'outbound';
  thread_id?: string;
  user_id?: string;
  event_id?: string;
  device_id?: string;
  from_entity_id?: string;
  to_entity_ids?: string[];
  participants_metadata?: Record<string, unknown>;
  subject?: string;
  content: string;
  attachments?: unknown[];
  duration_seconds?: number;
  sentiment_score?: number;
  importance_score?: number;
  urgency_score?: number;
  category?: string;
  summary?: string;
  connection_id?: string;
  is_encrypted?: boolean;
  is_archived?: boolean;
  preview?: string | null;
  // Provenance triple for idempotent re-ingest (see communications_source_triple_uniq).
  source_type?: string;
  source_system?: string;
  source_id?: string;
}

export const createCommunicationSchema = z.object({
  time: z.string(),
  communication_type: z.enum(['email', 'sms', 'call']),
  direction: z.enum(['inbound', 'outbound']),
  thread_id: z.string().optional(),
  device_id: z.string().optional(),
  from_entity_id: z.string().optional(),
  to_entity_ids: z.array(z.string()).optional(),
  participants_metadata: z.record(z.unknown()).optional(),
  subject: z.string().optional(),
  content: z.string(),
  attachments: z.array(z.unknown()).optional(),
  duration_seconds: z.number().optional(),
  sentiment_score: z.number().optional(),
  importance_score: z.number().optional(),
  urgency_score: z.number().optional(),
  category: z.string().optional(),
  summary: z.string().optional(),
  connection_id: z.string().optional(),
  is_encrypted: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  preview: z.string().optional(),
});

export interface UpdateCommunicationDto {
  time?: Date;
  communication_type?: 'email' | 'sms' | 'call';
  direction?: 'inbound' | 'outbound';
  thread_id?: string;
  device_id?: string;
  from_entity_id?: string;
  to_entity_ids?: string[];
  participants_metadata?: Record<string, unknown>;
  subject?: string;
  content: string;
  attachments?: unknown[];
  duration_seconds?: number;
  sentiment_score?: number;
  importance_score?: number;
  urgency_score?: number;
  category?: string;
  summary?: string;
  connection_id?: string;
  is_encrypted?: boolean;
  is_archived?: boolean;
  preview?: string | null;
}

export const updateCommunicationSchema = z.object({
  time: z.string().optional(),
  communication_type: z.enum(['email', 'sms', 'call']).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  thread_id: z.string().optional(),
  device_id: z.string().optional(),
  from_entity_id: z.string().optional(),
  to_entity_ids: z.array(z.string()).optional(),
  participants_metadata: z.record(z.unknown()).optional(),
  subject: z.string().optional(),
  content: z.string().optional(),
  attachments: z.array(z.unknown()).optional(),
  duration_seconds: z.number().optional(),
  sentiment_score: z.number().optional(),
  importance_score: z.number().optional(),
  urgency_score: z.number().optional(),
  category: z.string().optional(),
  summary: z.string().optional(),
  connection_id: z.string().optional(),
  is_encrypted: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  preview: z.string().optional(),
});

const createEventSchemaRoot = z.object({
  title: z.string(),
  description: z.string().optional(),
  event_type: z.string().optional(),
  category: z.string().optional(),
  start_time: z.string().datetime(),
  end_time: z.string().datetime().optional(),
  location_name: z.string().optional(),
  location_coordinates: z
    .object({
      type: z.string(),
      coordinates: z.array(z.number()),
    })
    .optional(),
  event_entity_id: z.string().optional(),
  location_entity_id: z.string().optional(),
  participant_entity_ids: z.array(z.string()).optional(),
  organizer_entity_id: z.string().optional(),
  source_type: z.string().optional(),
  source_system: z.string().optional(),
  source_id: z.string().optional(),
  confidence_score: z.number().optional(),
  is_recurring: z.boolean().optional(),
  recurrence_pattern: z.record(z.unknown()).optional(),
  is_all_day: z.boolean().optional(),
  is_private: z.boolean().optional(),
  priority: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
  is_predicted: z.boolean().optional(),
  is_inferred: z.boolean().optional(),
  prediction_model: z.string().optional(),
  inference_sources: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  sentiment_score: z.number().optional(),
  energy_level: z.number().optional(),
  productivity_impact: z.number().optional(),
  status: z.string().optional(),
  is_deleted: z.boolean().optional(),
  external_sync_status: z.string().optional(),
  last_synced_at: z.string().datetime().optional(),
  parent_event_id: z.string().optional(),
  related_event_ids: z.array(z.string()).optional(),
  supersedes_event_id: z.string().optional(),
  created_by: z.string().optional(),
  content: z.array(createContentSchema).optional(),
});

export const createEventSchema = z.union([createEventSchemaRoot, z.array(createEventSchemaRoot)]);

export const updateEventSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  event_type: z.string().optional(),
  category: z.string().optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  location_name: z.string().optional(),
  event_entity_id: z.string().optional(),
  location_entity_id: z.string().optional(),
  location_coordinates: z
    .object({
      type: z.string(),
      coordinates: z.array(z.number()),
    })
    .optional(),
  participant_entity_ids: z.array(z.string()).optional(),
  organizer_entity_id: z.string().optional(),
  source_type: z.string().optional(),
  source_system: z.string().optional(),
  source_id: z.string().optional(),
  confidence_score: z.number().optional(),
  is_recurring: z.boolean().optional(),
  recurrence_pattern: z.record(z.unknown()).optional(),
  is_all_day: z.boolean().optional(),
  is_private: z.boolean().optional(),
  priority: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
  is_predicted: z.boolean().optional(),
  is_inferred: z.boolean().optional(),
  prediction_model: z.string().optional(),
  inference_sources: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  sentiment_score: z.number().optional(),
  energy_level: z.number().optional(),
  productivity_impact: z.number().optional(),
  status: z.string().optional(),
  is_deleted: z.boolean().optional(),
  external_sync_status: z.string().optional(),
  last_synced_at: z.string().datetime().optional(),
  parent_event_id: z.string().optional(),
  related_event_ids: z.array(z.string()).optional(),
  supersedes_event_id: z.string().optional(),
  created_by: z.string().optional(),
  content: z.array(createContentSchema).optional(),
});
