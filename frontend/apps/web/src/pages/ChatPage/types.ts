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

export interface KnowledgeCard {
  id: string;
  messageId: string;
  source: Message['role'];
  sourceLabel: string;
  title: string;
  rawJson: string;
  formattedJson: string;
  data: unknown;
}
