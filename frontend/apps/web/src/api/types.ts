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
