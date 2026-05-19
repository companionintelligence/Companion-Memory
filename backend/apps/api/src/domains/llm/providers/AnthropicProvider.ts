import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';

import { ContextService } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ProviderKeyService } from '@ci/domains/connections';

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatResponseChunk,
  LlmProvider,
  LlmProviderCapabilities,
} from './LlmProvider';

/**
 * Plan 04 §3.4 — Anthropic Claude provider.
 *
 * Reads the user's Anthropic API key from `provider_keys` (provider name
 * 'anthropic') via `ContextService.getUserId()`. If no key exists for the
 * current user, calls will throw so the caller / router can fall back to
 * a local provider.
 *
 * Default model: claude-3-5-haiku-20241022 (fast, cheap, good for most tasks).
 * Callers can override via `opts.model`.
 */
const DEFAULT_MODEL = 'claude-3-5-haiku-20241022';
const PROVIDER_NAME = 'anthropic';

@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly name = PROVIDER_NAME;

  readonly capabilities: LlmProviderCapabilities = {
    embed: false,
    chat: true,
    toolCalls: true,
    stream: true,
  };

  constructor(
    private readonly providerKeyService: ProviderKeyService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AnthropicProvider.name);
  }

  // AnthropicProvider doesn't support embedding — router should never call this.
  async embed(): Promise<number[]> {
    throw new Error('AnthropicProvider does not support embedding');
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const client = await this.getClient();
    const model = opts.model ?? DEFAULT_MODEL;
    const { systemMessage, userMessages } = splitSystem(messages);

    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(systemMessage ? { system: systemMessage } : {}),
      messages: userMessages.map(toAnthropicMessage),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    return {
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      toolCalls:
        toolUses.length > 0
          ? toolUses.map((t) => ({
              name: t.name,
              arguments: t.input as Record<string, unknown>,
            }))
          : undefined,
    };
  }

  async *chatStream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncIterable<ChatResponseChunk> {
    const client = await this.getClient();
    const model = opts.model ?? DEFAULT_MODEL;
    const { systemMessage, userMessages } = splitSystem(messages);

    const stream = client.messages.stream({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(systemMessage ? { system: systemMessage } : {}),
      messages: userMessages.map(toAnthropicMessage),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { delta: event.delta.text, done: false };
      }
    }

    const final = await stream.finalMessage();
    yield {
      delta: '',
      done: true,
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      },
    };
  }

  private async getClient(): Promise<Anthropic> {
    const userId = ContextService.getUserId();

    if (!userId) {
      throw new Error('AnthropicProvider: no user in context — cannot load provider key');
    }

    const key = await this.providerKeyService.findByProviderName({ userId }, PROVIDER_NAME);

    if (!key) {
      throw new Error(`AnthropicProvider: no provider key found for user ${userId}`);
    }

    return new Anthropic({ apiKey: key.clientSecret });
  }
}

/** Extract the system message so it can be passed as Anthropic's top-level field. */
function splitSystem(messages: ChatMessage[]): {
  systemMessage: string | undefined;
  userMessages: ChatMessage[];
} {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const userMessages = messages.filter((m) => m.role !== 'system');

  return {
    systemMessage: systemMessages.map((m) => m.content).join('\n') || undefined,
    userMessages,
  };
}

function toAnthropicMessage(m: ChatMessage): Anthropic.MessageParam {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? 'unknown',
          content: m.content,
        },
      ],
    };
  }

  return {
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  };
}
