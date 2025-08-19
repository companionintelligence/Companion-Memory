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
