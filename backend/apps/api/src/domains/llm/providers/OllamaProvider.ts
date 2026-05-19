import { Injectable } from '@nestjs/common';
import { Ollama } from 'ollama';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatResponseChunk,
  EmbedOptions,
  LlmProvider,
  LlmProviderCapabilities,
} from './LlmProvider';

const DEFAULT_CHAT_MODEL = 'qwen3:14b';
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

/**
 * Plan 04 — local Ollama provider. Wraps the same `ollama` SDK the existing
 * OllamaService uses, but exposes the unified `LlmProvider` shape so callers
 * can swap to Anthropic/OpenAI later without surgery.
 *
 * The legacy OllamaService is unchanged for now; it will be migrated to call
 * through this provider in a subsequent refactor.
 */
@Injectable()
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';

  readonly capabilities: LlmProviderCapabilities = {
    embed: true,
    chat: true,
    toolCalls: true,
    stream: true,
  };

  private readonly ollama = new Ollama({ host: config.services.ollama.host });

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(OllamaProvider.name);
  }

  async embed(text: string, opts: EmbedOptions = {}): Promise<number[]> {
    const model = opts.model ?? DEFAULT_EMBED_MODEL;
    const result = await this.ollama.embed({ model, input: text });

    return result.embeddings[0] ?? [];
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const model = opts.model ?? DEFAULT_CHAT_MODEL;
    const result = await this.ollama.chat({
      model,
      messages: messages.map(toOllamaMessage),
      stream: false,
      ...(opts.format ? { format: opts.format } : {}),
      ...(opts.temperature !== undefined ? { options: { temperature: opts.temperature } } : {}),
    });

    return {
      text: result.message?.content ?? '',
      usage:
        result.prompt_eval_count != null && result.eval_count != null
          ? { inputTokens: result.prompt_eval_count, outputTokens: result.eval_count }
          : undefined,
      toolCalls: result.message?.tool_calls?.map((call) => ({
        name: call.function.name,
        arguments: (call.function.arguments ?? {}) as Record<string, unknown>,
      })),
    };
  }

  async *chatStream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncIterable<ChatResponseChunk> {
    const model = opts.model ?? DEFAULT_CHAT_MODEL;
    const stream = await this.ollama.chat({
      model,
      messages: messages.map(toOllamaMessage),
      stream: true,
      ...(opts.format ? { format: opts.format } : {}),
      ...(opts.temperature !== undefined ? { options: { temperature: opts.temperature } } : {}),
    });

    for await (const part of stream) {
      const usage =
        part.done && part.prompt_eval_count != null && part.eval_count != null
          ? { inputTokens: part.prompt_eval_count, outputTokens: part.eval_count }
          : undefined;

      yield {
        delta: part.message?.content ?? '',
        done: !!part.done,
        usage,
      };
    }
  }
}

function toOllamaMessage(m: ChatMessage) {
  // The ollama SDK accepts the role+content shape directly. Tool messages
  // are passed as role: 'tool' with the content set to the JSON result.
  return { role: m.role, content: m.content };
}
