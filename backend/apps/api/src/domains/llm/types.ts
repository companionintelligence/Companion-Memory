import type { User } from '@ci/domains/user';

export interface PromptInput {
  prompt?: string;
  model?: string;
  threadId?: string;
}

export interface MultipartPromptInput {
  input?: string;
}

export interface CreateMessageDto {
  threadId: string;
  model: string;
  prompt: boolean;
  text?: string;
  mimetype?: string;
  canceled?: boolean;
  promptMessageId?: string;
}

export interface UpdateMessageDto {
  text?: string;
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
  readonly text: string | null;
  readonly mimetype: string | null;
  readonly prompt: boolean | null;
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

export interface OllamaModel {
  model: string;
  namespace: string | null;
  name: string;
  tag: string | null;
}
