export interface PromptInput {
  prompt: string;
  model?: string;
  threadId?: string;
  enableTools?: boolean;
  enableThinking?: boolean;
  fileIds?: string[];
  /**
   * The action this turn is about, for a turn that starts a new thread from
   * the Today action window. See `OllamaController.generate`.
   */
  actionId?: string;
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
