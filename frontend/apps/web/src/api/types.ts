export interface Action {
  id: string;
  title: string;
  text: string;
  imageUrl?: string;
  threadId: string;
  tags: string[];
}

export interface File {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url?: string;
}

export interface Message {
  id: string;
  model: string;
  role: string;
  content: string;
  mimetype: string | null;
  toolCalls: object[] | null;
  canceled: boolean;
}

export interface Thread {
  id: string;
  name: string | null;
  model: string;
  description: string | null;
  messages?: Message[];
}

export interface UserContext {
  currentUser: {
    entityId: string;
    name: string;
    username: string | null;
    properties?: Record<string, unknown>;
  };
  familyMembers: Array<{
    entityId: string;
    name: string;
    relationship: string;
    age?: number;
    properties?: Record<string, unknown>;
  }>;
  topPreferences: Array<{
    entityId: string;
    name: string;
    type: string;
    strength: number;
    relationship: 'PREFERS' | 'DISLIKES';
  }>;
  quickStats: {
    totalEntities: number;
    totalPreferences: number;
    totalDislikes: number;
    familySize: number;
  };
}

export interface UserContextResponse {
  success: boolean;
  context: UserContext | null;
}
