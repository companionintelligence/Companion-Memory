/**
 * Plan 04 §3.1 — provider-agnostic LLM interface.
 *
 * Today only OllamaProvider implements this. Future commits add
 * AnthropicProvider, OpenAIProvider, OpenRouterProvider — selected per-task
 * by the LlmRouter based on a ModelPolicy. The router lives in
 * `LlmRouter.ts`; the existing OllamaService keeps working untouched and
 * will be wrapped by OllamaProvider in a follow-up.
 */

export type LlmTask = 'embed' | 'classify' | 'summarize' | 'chat' | 'reflect' | 'consolidate';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Abort signal for client-side cancellation. */
  signal?: AbortSignal;
  /** Names of tools the model is allowed to call. */
  tools?: string[];
  /** JSON-schema-like format constraint (e.g. structured output). */
  format?: 'json' | string;
}

export interface ChatResponseChunk {
  delta: string;
  done: boolean;
  /** Final usage stats; only set when `done: true`. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export interface EmbedOptions {
  model?: string;
  signal?: AbortSignal;
}

export interface LlmProviderCapabilities {
  embed: boolean;
  chat: boolean;
  toolCalls: boolean;
  stream: boolean;
}

export interface LlmProvider {
  /** Stable id: `ollama`, `anthropic`, `openai`, `openrouter`, `together`. */
  readonly name: string;

  /** Which call kinds this provider supports. The router uses this to skip
   * providers that can't service a given task. */
  readonly capabilities: LlmProviderCapabilities;

  /**
   * Returns a single embedding vector for the given text. The model id is
   * provider-specific; if omitted the provider picks its default embed model.
   */
  embed(text: string, opts?: EmbedOptions): Promise<number[]>;

  /** Non-streaming chat. Returns the full response. */
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResponse>;

  /** Streaming chat. Yields chunks until `done: true`. */
  chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ChatResponseChunk>;
}
