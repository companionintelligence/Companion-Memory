import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

import { ContextService } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ProviderKeyService } from '@ci/domains/connections';

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatResponseChunk,
  EmbedOptions,
  LlmProvider,
  LlmProviderCapabilities,
} from './LlmProvider';

/**
 * Plan 04 §3.5 — OpenAI provider.
 *
 * Reads the user's OpenAI API key from `provider_keys` (provider name
 * 'openai') via `ContextService.getUserId()`. If no key exists, calls throw
 * so the router can fall back to a local or other provider.
 *
 * Supports both chat completion and text embeddings (text-embedding-3-small
 * by default for embed calls; gpt-4o-mini for chat).
 */
const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
const PROVIDER_NAME = 'openai';

@Injectable()
export class OpenAiProvider implements LlmProvider {
  readonly name = PROVIDER_NAME;

  readonly capabilities: LlmProviderCapabilities = {
    embed: true,
    chat: true,
    toolCalls: true,
    stream: true,
  };

  constructor(
    private readonly providerKeyService: ProviderKeyService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OpenAiProvider.name);
  }

  async embed(text: string, opts: EmbedOptions = {}): Promise<number[]> {
    const client = await this.getClient();
    const model = opts.model ?? DEFAULT_EMBED_MODEL;
    const response = await client.embeddings.create({ model, input: text });

    return response.data[0]?.embedding ?? [];
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const client = await this.getClient();
    const model = opts.model ?? DEFAULT_CHAT_MODEL;

    const response = await client.chat.completions.create({
      model,
      messages: messages.map(toOpenAiMessage),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.format === 'json' ? { response_format: { type: 'json_object' } } : {}),
    });

    const choice = response.choices[0];
    const text = choice?.message?.content ?? '';
    const toolCalls = choice?.message?.tool_calls
      ?.filter((t): t is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } => t.type === 'function')
      .map((t) => ({
        name: t.function.name,
        arguments: safeParseJson(t.function.arguments),
      }));

    return {
      text,
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };
  }

  async *chatStream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncIterable<ChatResponseChunk> {
    const client = await this.getClient();
    const model = opts.model ?? DEFAULT_CHAT_MODEL;

    const stream = await client.chat.completions.create({
      model,
      messages: messages.map(toOpenAiMessage),
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }

      const done = chunk.choices[0]?.finish_reason != null;

      yield {
        delta,
        done,
        ...(done ? { usage: { inputTokens, outputTokens } } : {}),
      };
    }
  }

  private async getClient(): Promise<OpenAI> {
    const userId = ContextService.getUserId();

    if (!userId) {
      throw new Error('OpenAiProvider: no user in context — cannot load provider key');
    }

    const key = await this.providerKeyService.findByProviderName({ userId }, PROVIDER_NAME);

    if (!key) {
      throw new Error(`OpenAiProvider: no provider key found for user ${userId}`);
    }

    return new OpenAI({ apiKey: key.clientSecret });
  }
}

function toOpenAiMessage(m: ChatMessage): OpenAI.ChatCompletionMessageParam {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId ?? 'unknown',
      content: m.content,
    };
  }

  return { role: m.role, content: m.content } as OpenAI.ChatCompletionMessageParam;
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
