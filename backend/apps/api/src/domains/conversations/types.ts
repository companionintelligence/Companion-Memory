export interface CreateMessageDto {
  id?: string;
  threadId: string;
  role: string;
  model: string;
  content: string;
  mimetype?: string;
  toolCalls?: Record<string, unknown>[] | null;
  canceled?: boolean;
  promptMessageId?: string;
  fileIds?: string[]; // IDs of files to link to this message
}

export interface UpdateMessageDto {
  content?: string;
  canceled?: boolean;
}

export interface CreateThreadDto {
  id?: string;
  name?: string;
  model?: string;
  description?: string;
}

export interface UpdateThreadDto {
  name?: string;
  description?: string;
}
