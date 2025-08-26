import type { User } from '@ci/domains/user';

export interface CreateMessageDto {
  threadId: string;
  role: string;
  model: string;
  content: string;
  mimetype?: string;
  toolCalls?: Record<string, unknown>[] | null;
  canceled?: boolean;
  promptMessageId?: string;
}

export interface UpdateMessageDto {
  content?: string;
  canceled?: boolean;
}

export interface CreateThreadDto {
  name?: string;
  model?: string;
  description?: string;
}

export interface UpdateThreadDto {
  name?: string;
  description?: string;
}

export interface Message {
  readonly id: string;
  readonly model: string | null;
  readonly role: string;
  readonly content: string;
  readonly mimetype: string | null;
  readonly toolCalls: Record<string, unknown>[] | null;
  readonly canceled: boolean | null;
  readonly user?: User;
  readonly thread?: Thread;
  readonly promptMessage?: Message | null;
}

export interface Thread {
  readonly id: string;
  readonly name: string | null;
  readonly model: string | null;
  readonly description: string | null;
  readonly user?: User;
}
