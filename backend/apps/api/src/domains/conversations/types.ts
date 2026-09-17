export interface CreateMessageDto {
  id?: string;
  threadId: string;
  role: string;
  model: string;
  content: string;
  source?: 'openclaw' | 'memory' | 'user';
  mimetype?: string;
  toolCalls?: Record<string, unknown>[] | null;
  canceled?: boolean;
  promptMessageId?: string;
  fileIds?: string[]; // IDs of files to link to this message
}

export interface UpdateMessageDto {
  content?: string;
  canceled?: boolean;
  toolCalls?: Record<string, unknown>[] | null;
}

export interface CreateThreadDto {
  id?: string;
  name?: string;
  model?: string;
  description?: string;
  kind?: 'chat' | 'dispatch';
  generationStatus?: 'idle' | 'queued' | 'running' | 'failed';
}

export interface UpdateThreadDto {
  name?: string;
  description?: string;
  generationStatus?: 'idle' | 'queued' | 'running' | 'failed';
}
