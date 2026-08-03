import type { ChatResponse, Message as OllamaMessage, Tool, ToolCall } from 'ollama';
import OpenAI from 'openai';
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

/**
 * OpenAI-protocol transport for the chat path, used when `LLM_API_BASE` points
 * at a non-Ollama backend (a Hub-selected vLLM instance, or any other
 * OpenAI-compatible server). It speaks `/v1/chat/completions` (+ `/v1/models`)
 * but presents Ollama-shaped requests/responses, so `OllamaService`'s tool loop
 * and the SSE controller work unchanged against either transport.
 *
 * Protocol differences bridged here:
 * - Tool results need a `tool_call_id` in the OpenAI protocol; Ollama pairs
 *   assistant tool_calls with the following `tool` messages positionally, so
 *   deterministic ids are synthesized during conversion (see toOpenAiMessages).
 * - Streamed tool calls arrive as incremental JSON argument fragments keyed by
 *   index; they're accumulated and emitted once, parsed, as a final
 *   Ollama-shaped chunk.
 * - Vision input: Ollama's `images: [bytes|base64]` becomes `image_url` content
 *   parts with data URLs.
 * - Reasoning: vLLM-style `reasoning_content` deltas map onto Ollama's
 *   `message.thinking` so the THINK channel keeps streaming.
 */
export class OpenAiCompatChatDriver {
  private readonly client: OpenAI;

  constructor(baseURL: string, apiKey: string) {
    this.client = new OpenAI({ baseURL, apiKey });
  }

  /** Model ids served by the backend (`GET /v1/models`). */
  async listModels(): Promise<string[]> {
    const models = await this.client.models.list();

    return models.data.map((model) => model.id);
  }

  async chat(request: {
    model: string;
    messages: OllamaMessage[];
    tools?: Tool[];
    format?: string;
  }): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model,
      messages: toOpenAiMessages(request.messages),
      ...(request.tools && request.tools.length > 0 && { tools: toOpenAiTools(request.tools) }),
      // Ollama's `format: 'json'` maps onto the OpenAI json_object response format.
      ...(request.format === 'json' && { response_format: { type: 'json_object' as const } }),
    });

    const choice = response.choices[0];

    return toChatResponse(request.model, {
      content: choice?.message?.content ?? '',
      toolCalls: (choice?.message?.tool_calls ?? [])
        .filter(
          (call): call is ChatCompletionMessageToolCall & { type: 'function' } => call.type === 'function',
        )
        .map((call) => ({
          function: {
            name: call.function.name,
            arguments: safeParseArguments(call.function.arguments),
          },
        })),
      done: true,
    });
  }

  /**
   * One streamed completion (no tool loop — the caller owns that), yielding
   * Ollama-shaped chunks: content deltas, thinking deltas, and a single final
   * chunk carrying any accumulated tool calls. Abort errors from the signal are
   * swallowed so cancellation ends the stream quietly, matching the native
   * path's behavior.
   */
  async *chatStream(request: {
    model: string;
    messages: OllamaMessage[];
    tools?: Tool[];
    signal?: AbortSignal;
  }): AsyncGenerator<ChatResponse> {
    const stream = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: toOpenAiMessages(request.messages),
        stream: true,
        ...(request.tools && request.tools.length > 0 && { tools: toOpenAiTools(request.tools) }),
      },
      { signal: request.signal },
    );

    // Streamed tool calls arrive fragmented: an entry with id+name at some
    // index, then argument string fragments for that index. Accumulate by index.
    const pendingToolCalls = new Map<number, { name: string; argumentChunks: string[] }>();

    try {
      for await (const part of stream) {
        const delta = part.choices[0]?.delta;

        if (delta == null) {
          continue;
        }

        for (const toolCall of delta.tool_calls ?? []) {
          const entry = pendingToolCalls.get(toolCall.index) ?? { name: '', argumentChunks: [] };

          if (toolCall.function?.name) {
            entry.name = toolCall.function.name;
          }

          if (toolCall.function?.arguments) {
            entry.argumentChunks.push(toolCall.function.arguments);
          }

          pendingToolCalls.set(toolCall.index, entry);
        }

        if (delta.content) {
          yield toChatResponse(request.model, { content: delta.content, done: false });
        }

        // vLLM (and other reasoning-capable OpenAI-compatible servers) stream
        // the reasoning trace as a non-standard `reasoning_content` delta.
        const thinking = (delta as { reasoning_content?: string }).reasoning_content;

        if (thinking) {
          yield toChatResponse(request.model, { thinking, done: false });
        }
      }
    } catch (err) {
      if (request.signal?.aborted) {
        return;
      }

      throw err;
    }

    if (pendingToolCalls.size > 0) {
      const toolCalls: ToolCall[] = [...pendingToolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, entry]) => entry.name.length > 0)
        .map(([, entry]) => ({
          function: {
            name: entry.name,
            arguments: safeParseArguments(entry.argumentChunks.join('')),
          },
        }));

      if (toolCalls.length > 0) {
        yield toChatResponse(request.model, { toolCalls, done: false });
      }
    }

    yield toChatResponse(request.model, { done: true });
  }
}

/** Assemble an Ollama-`ChatResponse`-shaped chunk from the given parts. */
function toChatResponse(
  model: string,
  parts: { content?: string; thinking?: string; toolCalls?: ToolCall[]; done: boolean },
): ChatResponse {
  return {
    model,
    created_at: new Date(),
    message: {
      role: 'assistant',
      content: parts.content ?? '',
      ...(parts.thinking && { thinking: parts.thinking }),
      ...(parts.toolCalls && parts.toolCalls.length > 0 && { tool_calls: parts.toolCalls }),
    },
    done: parts.done,
    done_reason: parts.done ? 'stop' : '',
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: 0,
    prompt_eval_duration: 0,
    eval_count: 0,
    eval_duration: 0,
  };
}

/**
 * Convert an Ollama-shaped conversation to OpenAI chat messages.
 *
 * Exported for tests. The tricky part is tool plumbing: the OpenAI protocol
 * requires assistant `tool_calls` to carry ids that the following `tool`
 * messages reference, while Ollama has no ids and pairs them positionally.
 * Ids are synthesized in order and handed to the subsequent tool messages in
 * the same order, which is exactly how OllamaService's tool loop emits them.
 */
export function toOpenAiMessages(messages: OllamaMessage[]): ChatCompletionMessageParam[] {
  const converted: ChatCompletionMessageParam[] = [];
  const pendingToolCallIds: string[] = [];
  let callCounter = 0;

  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const ids = message.tool_calls.map(() => `call_${callCounter++}`);

      pendingToolCallIds.splice(0, pendingToolCallIds.length, ...ids);
      converted.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.tool_calls.map((toolCall, i) => ({
          id: ids[i],
          type: 'function' as const,
          function: {
            name: toolCall.function.name,
            arguments: JSON.stringify(toolCall.function.arguments ?? {}),
          },
        })),
      });

      continue;
    }

    if (message.role === 'tool') {
      converted.push({
        role: 'tool',
        tool_call_id: pendingToolCallIds.shift() ?? `call_${callCounter++}`,
        content: message.content ?? '',
      });

      continue;
    }

    if (message.images && message.images.length > 0 && message.role === 'user') {
      const parts: ChatCompletionContentPart[] = [
        { type: 'text', text: message.content ?? '' },
        ...message.images.map(
          (image): ChatCompletionContentPart => ({
            type: 'image_url',
            image_url: { url: toDataUrl(image) },
          }),
        ),
      ];

      converted.push({ role: 'user', content: parts });

      continue;
    }

    converted.push({
      role: message.role as 'system' | 'user' | 'assistant',
      content: message.content ?? '',
    });
  }

  return converted;
}

/** Ollama tools and OpenAI tools share the function-call JSON-schema shape. */
export function toOpenAiTools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.function.name ?? '',
      description: tool.function.description,
      parameters: tool.function.parameters as Record<string, unknown>,
    },
  }));
}

/**
 * Parse a tool-call arguments payload, tolerating the malformed JSON smaller
 * models sometimes emit — a failed call with empty args beats a crashed stream.
 */
function safeParseArguments(raw: unknown): Record<string, unknown> {
  if (raw != null && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    return parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Ollama carries images as raw bytes or base64 strings with no mime type; data
 * URLs need one. Servers decode the actual bytes (sniffing the real format), so
 * a generic image/jpeg label is safe for JPEG/PNG alike.
 */
function toDataUrl(image: Uint8Array | string): string {
  const base64 = typeof image === 'string' ? image : Buffer.from(image).toString('base64');

  return `data:image/jpeg;base64,${base64}`;
}
