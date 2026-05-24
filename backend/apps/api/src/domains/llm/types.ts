export interface PromptInput {
  prompt: string;
  model?: string;
  threadId?: string;
  enableTools?: boolean;
  enableThinking?: boolean;
  fileIds?: string[];
}

export interface OllamaModel {
  model: string;
  namespace: string | null;
  name: string;
  tag: string | null;
  capabilities?: string[];
  vision?: boolean;
  tools?: boolean;
  thinking?: boolean;
}
