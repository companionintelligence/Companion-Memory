export interface PromptInput {
  prompt: string;
  model?: string;
  threadId?: string;
  enableTools?: boolean;
}

export interface OllamaModel {
  model: string;
  namespace: string | null;
  name: string;
  tag: string | null;
}
