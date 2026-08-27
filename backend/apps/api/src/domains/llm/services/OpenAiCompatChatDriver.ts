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
 * - Reasoning: Ollama uses `think: true`. vLLM/Qwen uses
 *   `chat_template_kwargs.enable_thinking` plus `reasoning_content` deltas,
 *   which we map onto Ollama's `message.thinking`.
 * - Tools: Ollama returns structured `message.tool_calls`. vLLM only does that
 *   when `--tool-call-parser` matches the model's markup; Qwen3.6 often dumps
 *   `<toolcall><function=…>` into `content` instead (same finding as
 *   tool_choice=auto on Qwen2.5-Coder). We salvage that markup into the same
 *   Ollama tool_calls the rest of the stack already executes.
 */

/** vLLM/Qwen thinks unless this is in the JSON body; openai-node may strip unknown fields. */
export function vllmThinkingExtraBody(enableThinking?: boolean): {
  chat_template_kwargs: { enable_thinking: boolean };
} {
  return {
    chat_template_kwargs: { enable_thinking: enableThinking === true },
  };
}

export class OpenAiCompatChatDriver {
  private readonly client: OpenAI;

  constructor(baseURL: string, apiKey: string) {
    this.client = new OpenAI({
      baseURL,
      apiKey,
      // Default is 10 minutes with retries. Background accoutrements then occupy
      // vLLM's `--max-num-seqs` slots until the GPU is unreachable for chat.
      timeout: 180_000,
      maxRetries: 0,
    });
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
    enableThinking?: boolean;
  }): Promise<ChatResponse> {
    const extraBody = vllmThinkingExtraBody(request.enableThinking);
    const response = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: toOpenAiMessages(request.messages),
        ...(request.tools && request.tools.length > 0 && { tools: toOpenAiTools(request.tools) }),
        // Ollama's `format: 'json'` maps onto the OpenAI json_object response format.
        ...(request.format === 'json' && { response_format: { type: 'json_object' as const } }),
        ...extraBody,
      },
      { timeout: 180_000, maxRetries: 0 },
    );

    const choice = response.choices[0];
    const structured = (choice?.message?.tool_calls ?? [])
      .filter(
        (call): call is ChatCompletionMessageToolCall & { type: 'function' } => call.type === 'function',
      )
      .map((call) => ({
        function: {
          name: call.function.name,
          arguments: safeParseArguments(call.function.arguments),
        },
      }));
    const rawContent = choice?.message?.content ?? '';
    const salvaged = extractEmbeddedToolCalls(rawContent);
    const toolCalls = structured.length > 0 ? structured : salvaged.toolCalls;
    const content =
      toolCalls.length > 0 || salvaged.toolCalls.length > 0 ? stripToolMarkup(rawContent) : rawContent;

    return toChatResponse(request.model, {
      content,
      toolCalls,
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
    enableThinking?: boolean;
    salvageTools?: boolean;
    /**
     * Cap on the completion, in tokens. Unlike Ollama's `num_ctx` this bounds
     * only the answer — the prompt is bounded upstream by the context budget's
     * admission pass. Absent leaves the server's default alone.
     */
    maxTokens?: number;
  }): AsyncGenerator<ChatResponse> {
    const extraBody = vllmThinkingExtraBody(request.enableThinking);
    const stream = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: toOpenAiMessages(request.messages),
        stream: true,
        ...(request.tools && request.tools.length > 0 && { tools: toOpenAiTools(request.tools) }),
        ...(request.maxTokens != null && request.maxTokens > 0 && { max_tokens: request.maxTokens }),
        ...extraBody,
      },
      { signal: request.signal, timeout: 180_000, maxRetries: 0 },
    );

    // Streamed tool calls arrive fragmented: an entry with id+name at some
    // index, then argument string fragments for that index. Accumulate by index.
    const pendingToolCalls = new Map<number, { name: string; argumentChunks: string[] }>();
    const contentChunks: string[] = [];
    // Buffer text whenever this chat may emit tool markup — including follow-up
    // turns that no longer advertise tools. Streaming `<toolcall>` as TEXT is
    // what made Confirm-home look like a successful call.
    const bufferContent = Boolean(request.tools && request.tools.length > 0) || request.salvageTools === true;

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
          if (bufferContent) {
            contentChunks.push(delta.content);
          } else {
            yield toChatResponse(request.model, { content: delta.content, done: false });
          }
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

    const structured: ToolCall[] = [...pendingToolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, entry]) => entry.name.length > 0)
      .map(([, entry]) => ({
        function: {
          name: entry.name,
          arguments: safeParseArguments(entry.argumentChunks.join('')),
        },
      }));

    const rawContent = contentChunks.join('');
    const salvaged = extractEmbeddedToolCalls(rawContent);
    const toolCalls = structured.length > 0 ? structured : salvaged.toolCalls;
    const prose =
      toolCalls.length > 0 || salvaged.toolCalls.length > 0 || /<tool_?call\b|<function=/i.test(rawContent)
        ? stripToolMarkup(rawContent)
        : rawContent;

    if (bufferContent && prose.trim() !== '') {
      yield toChatResponse(request.model, { content: prose, done: false });
    }

    if (toolCalls.length > 0) {
      yield toChatResponse(request.model, { toolCalls, done: false });
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

  return hoistSystemMessages(converted);
}

/**
 * Qwen (and vLLM's Qwen chat template) rejects any system message that is not
 * the first message. Inference and chat both accumulate several system blocks;
 * hoist and join them so the template sees one leading system turn.
 */
function hoistSystemMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const systemParts: string[] = [];
  const rest: ChatCompletionMessageParam[] = [];

  for (const message of messages) {
    if (message.role !== 'system') {
      rest.push(message);
      continue;
    }

    if (typeof message.content === 'string' && message.content.trim() !== '') {
      systemParts.push(message.content);
    }
  }

  if (systemParts.length === 0) {
    return messages;
  }

  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest];
}

/**
 * Lift Qwen/vLLM tool markup out of assistant text. Ollama already returns
 * structured `tool_calls`; vLLM with `--tool-call-parser qwen3_coder` often
 * does not, and the model writes `<toolcall><function=name>…` into content
 * instead. Same loop in OllamaService executes either shape.
 */
export function extractEmbeddedToolCalls(content: string): { prose: string; toolCalls: ToolCall[] } {
  if (!content || !/<tool_?call\b|<function=/i.test(content)) {
    return { prose: content, toolCalls: [] };
  }

  const toolCalls: ToolCall[] = [];

  const consumeFunctions = (block: string) => {
    const closed = [...block.matchAll(/<function\s*=\s*([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/gi)];
    for (const match of closed) {
      const name = match[1]?.trim();
      if (!name) {
        continue;
      }

      const args: Record<string, unknown> = {};
      for (const param of match[2].matchAll(/<parameter\s*=\s*([^>\s]+)>([\s\S]*?)<\/parameter>/gi)) {
        args[param[1]] = coerceParamValue(param[2].trim());
      }

      if (Object.keys(args).length === 0) {
        const jsonMatch = match[2].trim().match(/^\{[\s\S]*\}$/);
        if (jsonMatch) {
          Object.assign(args, safeParseArguments(jsonMatch[0]));
        }
      }

      toolCalls.push(normalizeSalvagedToolCall(name, args));
    }
  };

  const blockRe = /<tool_?call\b[^>]*>([\s\S]*?)(?:<\/tool_?call>|$)/gi;
  const blocks = [...content.matchAll(blockRe)];
  if (blocks.length > 0) {
    for (const block of blocks) {
      consumeFunctions(block[1]);
      if (toolCalls.length === 0) {
        consumeQwenCoderBlock(block[1], toolCalls);
      }
    }
  } else {
    consumeFunctions(content);
  }

  if (toolCalls.length === 0) {
    return { prose: content, toolCalls: [] };
  }

  return { prose: stripToolMarkup(content), toolCalls };
}

/** Drop Qwen/vLLM tool XML (and the "Calling foo..." line) from assistant text. */
export function stripToolMarkup(content: string): string {
  return content
    .replace(/<tool_?call\b[^>]*>[\s\S]*?(?:<\/tool_?call>|$)/gi, '')
    .replace(/<function\s*=\s*[^>\s]+>[\s\S]*?(?:<\/function>|$)/gi, '')
    .replace(/Calling\s+\S+\.{0,3}\s*$/i, '')
    .trim();
}

function consumeQwenCoderBlock(block: string, toolCalls: ToolCall[]): void {
  const trimmed = block.trim();
  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return;
  }

  const name = lines[0];
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
    return;
  }

  const rest = lines.slice(1).join('\n');
  toolCalls.push(normalizeSalvagedToolCall(name, safeParseArguments(rest)));
}

function coerceParamValue(raw: string): unknown {
  if (raw.startsWith('{') || raw.startsWith('[')) {
    const parsed = safeParseArguments(raw);
    if (Object.keys(parsed).length > 0 || raw === '{}') {
      return parsed;
    }
  }

  return raw;
}

/**
 * Chat advertises dotted intents as `memory_remember`. Qwen3.6 often emits a
 * GraphQL-ish mash (`knowledgecreateEntity`) with the same payload; wrap that
 * as the native write so the tool loop can actually run.
 */
function canonicalizeToolName(name: string): string {
  const intentName = name.replace(/\./g, '_');
  const mashed = name.replace(/[_.-]/g, '').toLowerCase();

  if (mashed === 'memoryremember') {
    return 'memory_remember';
  }

  return intentName;
}

function normalizeSalvagedToolCall(name: string, args: Record<string, unknown>): ToolCall {
  const intentName = canonicalizeToolName(name);
  const mashed = name.replace(/[_.-]/g, '').toLowerCase();

  if (mashed.endsWith('createentity') && (args.entityType != null || args.name != null)) {
    const properties =
      typeof args.properties === 'string' ? coerceParamValue(args.properties) : args.properties;

    return {
      function: {
        name: 'memory_remember',
        arguments: {
          operations: [
            {
              kind: 'entity.create',
              entityType: String(args.entityType ?? 'place'),
              name: String(args.name ?? ''),
              ...(properties != null && typeof properties === 'object'
                ? { properties: properties as Record<string, unknown> }
                : {}),
            },
          ],
        },
      },
    };
  }

  return { function: { name: intentName, arguments: args } };
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
