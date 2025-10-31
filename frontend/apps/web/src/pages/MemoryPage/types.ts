export interface MemoryItem {
  id: string;
  type:
    | 'event'
    | 'content'
    | 'browser'
    | 'thing'
    | 'person'
    | 'contact'
    | 'place'
    | 'concept'
    | 'communication'
    | 'other';
  title: string;
  description: string | null;
  timestamp: string;
  category: string;
  location?: {
    id: string;
    name: string | null;
    lat: number;
    lng: number;
    address?: string;
  };
  tags: string[];
  userId: string;
  metadata?: {
    communicationType?: string;
    direction?: string;
    participantsMetadata?: unknown;
    source?: string;
    relationships?: Array<{
      type: string;
      targetId: string;
      targetName: string;
      targetType: string;
      direction: 'outgoing' | 'incoming';
    }>;
    properties?: {
      type?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  startDate?: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
  organizer?: string;
  repeatingFrequency?: string;
  duration?: number;
  source?: string;
  sourceLink?: string;
  file?: FileMeta;
}

export type Relationship = {
  type: string;
  targetId: string;
  targetName: string;
  targetType: string;
  direction: 'outgoing' | 'incoming';
};

export interface ParticipantData {
  name?: string;
  email?: string;
}

export interface FileMeta {
  id: string;
  name: string;
  contentType: string;
  size: string;
  url?: string;
}

export interface SearchResult {
  text: string;
  type: string;
  id: string;
  path: string;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
}
