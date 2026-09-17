export interface Message {
  id: string;
  model: string;
  role: string;
  source?: 'openclaw' | 'memory' | 'user';
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
  generationStatus?: 'idle' | 'queued' | 'running' | 'failed';
  kind?: 'chat' | 'dispatch';
  messages?: Message[];
}
