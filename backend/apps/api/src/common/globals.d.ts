declare module 'ollama' {
  export interface OllamaConfig {
    readonly host?: string;
  }

  export interface EmbeddingsRequest {
    readonly model: string;
    readonly prompt: string;
  }

  export interface EmbeddingsResponse {
    readonly embedding: number[];
  }

  export interface GenerateRequest {
    readonly model: string;
    readonly prompt: string;
  }

  export interface GenerateStreamRequest extends GenerateRequest {
    readonly stream: true;
  }

  export interface GenerateResponse {
    readonly model: string;
    readonly response?: string;
    readonly done?: boolean;
    readonly done_reason?: string;
    readonly total_duration?: number;
    readonly load_duration?: number;
    readonly prompt_eval_duration?: number;
    readonly prompt_eval_count?: number;
    readonly eval_count?: number;
  }

  export interface ToolCall {
    readonly id?: string;
    readonly function?: {
      readonly name: string;
      readonly arguments: string;
    };
    readonly name?: string;
    readonly arguments?: string | Record<string, unknown>;
    readonly type?: string;
  }

  export interface Message {
    readonly role: string;
    readonly content?: string;
    readonly thinking?: string;
    readonly images?: string[];
    readonly tool_calls?: ToolCall[];
  }

  export interface Tool {
    readonly type: 'function';
    readonly function: {
      readonly name: string;
      readonly description?: string;
      readonly parameters?: Record<string, unknown>;
    };
  }

  export interface ChatRequest {
    readonly model: string;
    readonly messages: Message[];
    readonly tools?: Tool[];
    readonly keep_alive?: string | number;
    readonly format?: string;
    readonly think?: boolean;
  }

  export interface ChatStreamRequest extends ChatRequest {
    readonly stream: true;
  }

  export interface ChatResponse {
    readonly model: string;
    readonly message: Message;
    readonly done?: boolean;
    readonly done_reason?: string;
    readonly total_duration?: number;
    readonly load_duration?: number;
    readonly prompt_eval_duration?: number;
    readonly prompt_eval_count?: number;
    readonly eval_count?: number;
  }

  export interface ListModelsResponse {
    readonly models: Array<{ name: string }>;
  }

  export type StreamIterator<T> = AsyncGenerator<T> & { abort: () => void };

  export class Ollama {
    constructor(config?: OllamaConfig);

    embeddings(request: EmbeddingsRequest): Promise<EmbeddingsResponse>;

    generate(request: GenerateRequest): Promise<GenerateResponse>;

    generate(request: GenerateStreamRequest): Promise<StreamIterator<GenerateResponse>>;

    chat(request: ChatRequest): Promise<ChatResponse>;

    chat(request: ChatStreamRequest): Promise<StreamIterator<ChatResponse>>;

    list(): Promise<ListModelsResponse>;
  }
}
