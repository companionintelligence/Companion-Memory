export interface Action {
  id: string;
  title: string;
  text: string;
  imageUrl?: string;
  threadId: string;
  tags: string[];
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

export interface File {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url?: string;
}

export interface Tag {
  readonly id: string;
  readonly label: string | null;
  readonly user_id: string | null;
  readonly created_at: string;
}

export interface CreateTagDto {
  label: string;
}

export interface UpdateTagDto {
  label?: string;
}
