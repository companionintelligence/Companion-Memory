export interface Memory {
  id: string;
  type: 'event' | 'content' | 'thing' | 'person' | 'contact';
  title: string;
  description: string | null;
  timestamp: Date;
  category: string;
  location?: MemoryLocation;
  tags: string[];
  userId: string;
  metadata?: {
    eventId?: string;
    eventType?: string;
    eventName?: string;
    synthetic?: boolean;
    personRef?: string;
    contentRef?: string;
    thingRef?: string;
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
  readonly name: string | null;
  readonly type: string | null;
  readonly description: string | null;
  readonly start_time: Date | null;
  readonly end_time: Date | null;
  readonly external_id: string | null;
  readonly source_url: string | null;
  readonly source_data: object | null;
  readonly user_id: string | undefined;
  readonly connection_id: string | undefined;
}

export interface CreateEventDto {
  id: string;
  name: string;
  type: string;
  description: string;
  start_time: Date;
  end_time: Date;
  external_id: string;
  source_url: string;
  source_data: object;
  user_id: string;
  connection_id?: string;
  user?: {
    id: string;
  };
}

export interface UpdateEventDto {
  id?: string;
  name?: string;
  type?: string;
  description?: string;
  start_time?: Date;
  end_time?: Date;
  external_id?: string;
  source_url?: string;
  source_data?: object;
  user_id?: string;
  connection_id?: string;
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
  id: string;
  type: string;
  title: string;
  text: string;
  url: string;
  mimetype: string;
  external_id: string;
  source_url: string;
  user_id: string;
  event_id: string;
}
