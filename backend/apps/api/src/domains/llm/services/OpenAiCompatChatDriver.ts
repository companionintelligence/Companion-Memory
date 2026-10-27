import type { ChatResponse, Message as OllamaMessage, Tool, ToolCall } from 'ollama';
import OpenAI from 'openai';
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import config from '@ci/configuration';

import {
  type ServedModel,
  type ServerProps,
  servedModelFromRow,
  serverPropsFromPayload,
} from './servedModels';

/** How long one `/props` answer stands in for the server: the values change only when the server is restarted. */
const SERVER_PROPS_TTL_MS = 5 * 60_000;

/**
 * How long a refused `reasoning_effort: "none"` keeps the field off. Not the
 * driver's life: the engine behind one URL can change (a Hub swapping vLLM
 * for Ollama, or a vLLM upgrade that accepts "none"), and a Hub pool can put
 * peers on different engines behind it, where one refusal used to stop the
 * field for an Ollama peer that needs it.
 */
const REASONING_EFFORT_REFUSAL_TTL_MS = 5 * 60_000;

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
 *   which we map onto Ollama's `message.thinking`. Ollama's own `/v1` reads
 *   neither and takes `reasoning_effort: "none"` for thinking off; see
 *   {@link thinkingBody}.
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

/**
 * The thinking switch for every OpenAI-compatible backend: vLLM's
 * `chat_template_kwargs`, plus `reasoning_effort: "none"` whenever thinking is
 * off. Ollama's `/v1` ignores `chat_template_kwargs` (and a top-level `think`),
 * so on Ollama or a Hub pool in front of it a thinking model reasoned
 * anyway: background jobs that ask for thinking off and cap the reply spent
 * the whole cap on reasoning and got empty content back (answer inference on
 * qwen3.5:9b, 800 of 800 tokens; image descriptions on gemma4:e2b, 256 of
 * 256). Ollama maps `reasoning_effort: "none"` to `think: false`. Not sent
 * for a while after this backend refused it (vLLM accepts only low, medium or high);
 * see {@link isReasoningEffortRejection}.
 */
export function thinkingBody(
  enableThinking: boolean | undefined,
  reasoningEffortRejected = false,
): ReturnType<typeof vllmThinkingExtraBody> & { reasoning_effort?: 'none' } {
  return {
    ...vllmThinkingExtraBody(enableThinking),
    ...(enableThinking !== true && !reasoningEffortRejected && { reasoning_effort: 'none' as const }),
  };
}

/**
 * A 4xx that blames `reasoning_effort`: how a backend that validates the field
 * refuses "none" (vLLM's request model allows only low, medium and high).
 */
export function isReasoningEffortRejection(err: unknown): boolean {
  return isClientErrorNaming(err, ['reasoning_effort', 'reasoning effort', 'invalid reasoning value']);
}

/** A 4xx whose message names any of `markers` (lower case), which is how a backend says which field it refused. */
function isClientErrorNaming(err: unknown, markers: readonly string[]): boolean {
  const status = (err as { status?: unknown } | null)?.status;

  if (typeof status !== 'number' || status < 400 || status >= 500) {
    return false;
  }

  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();

  return markers.some((marker) => message.includes(marker));
}

type ResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown> } };

/**
 * Ollama's `format` as an OpenAI `response_format`. A JSON Schema goes over as `json_schema`, which
 * vLLM, llama.cpp (so Lemonade), SGLang and Ollama's own `/v1` all enforce during decoding; plain
 * `json_object` only promises some valid JSON, which is what structured callers used to get on every
 * OpenAI-compatible backend. Once a backend has rejected `json_schema`, schemas degrade to
 * `json_object` for it.
 */
export function toResponseFormat(
  format: string | Record<string, unknown> | undefined,
  jsonSchemaRejected = false,
): ResponseFormat | undefined {
  if (format === 'json') {
    return { type: 'json_object' };
  }

  if (format == null || typeof format !== 'object') {
    return undefined;
  }

  return jsonSchemaRejected
    ? { type: 'json_object' }
    : { type: 'json_schema', json_schema: { name: 'response', schema: format } };
}

/**
 * A 4xx that blames the response format — how a backend without structured-output support refuses
 * `json_schema` (vLLM started without guided decoding, older llama.cpp builds). Anything else
 * (overflow, unknown model, auth) is not retried here.
 */
export function isResponseFormatRejection(err: unknown): boolean {
  return isClientErrorNaming(err, [
    'response_format',
    'json_schema',
    'structured output',
    'guided decoding',
    'grammar',
  ]);
}

export class OpenAiCompatChatDriver {
  private readonly client: OpenAI;

  /** Set once this endpoint has refused a `json_schema` response format; see {@link toResponseFormat}. */
  private jsonSchemaRejected = false;

  /** When this endpoint last refused `reasoning_effort: "none"`; see {@link thinkingBody}. */
  private reasoningEffortRejectedAt: number | null = null;

  /** Whether the field stays off: a refusal within {@link REASONING_EFFORT_REFUSAL_TTL_MS}. */
  private get reasoningEffortRejected(): boolean {
    return (
      this.reasoningEffortRejectedAt != null &&
      Date.now() - this.reasoningEffortRejectedAt < REASONING_EFFORT_REFUSAL_TTL_MS
    );
  }

  /** The last `/props` answer (a `null` answer is remembered too) and when it was taken. */
  private serverPropsCache: { at: number; value: ServerProps | null } | null = null;

  constructor(
    /** The `/v1` root this driver talks to, for a caller that speaks a route the SDK does not. */
    readonly baseUrl: string,
    readonly apiKey: string,
  ) {
    const baseURL = baseUrl;

    this.client = new OpenAI({
      baseURL,
      apiKey,
      // Default is 10 minutes with retries. Background accoutrements then occupy
      // vLLM's `--max-num-seqs` slots until the GPU is unreachable for chat.
      // The SDK clears this timer once response headers arrive (client.js
      // `fetchWithTimeout`), so it is the same first-response deadline the
      // native path applies through `firstResponseDeadline.ts`.
      timeout: config.llm.firstResponseTimeoutMs,
      maxRetries: 0,
    });
  }

  /**
   * llama-server's `GET /props`, read from the server root beside `/v1`: the loaded context window
   * and the modalities the model took. `null` for any server that does not answer it in that
   * shape (Lemonade's `/props` is its web page; vLLM has no such route) — remembered for a few
   * minutes either way, so a listing does not cost an extra round trip each time.
   */
  async serverProps(): Promise<ServerProps | null> {
    const now = Date.now();

    if (this.serverPropsCache && now - this.serverPropsCache.at < SERVER_PROPS_TTL_MS) {
      return this.serverPropsCache.value;
    }

    let value: ServerProps | null = null;

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/props`, {
        headers: {
          Accept: 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(3_000),
      });

      if (response.ok && (response.headers.get('content-type') ?? '').includes('json')) {
        value = serverPropsFromPayload(await response.json());
      }
    } catch {
      value = null;
    }

    this.serverPropsCache = { at: now, value };

    return value;
  }

  /** Model ids served by the backend (`GET /v1/models`). */
  async listModels(): Promise<string[]> {
    return (await this.listServedModels()).map((model) => model.id);
  }

  /**
   * Served models with whatever each backend adds to its `/v1/models` rows: capability labels
   * (Lemonade) and the context window it runs the model with (Lemonade, vLLM). See
   * {@link servedModelFromRow}; a backend that adds nothing yields empty labels and a `null` window.
   */
  async listServedModels(): Promise<ServedModel[]> {
    const models = await this.client.models.list();

    return models.data.map((model) =>
      servedModelFromRow(model as unknown as { id: string } & Record<string, unknown>),
    );
  }

  async chat(request: {
    model: string;
    messages: OllamaMessage[];
    tools?: Tool[];
    /** Ollama's `format`: `'json'`, or a JSON Schema object the reply must match. */
    format?: string | Record<string, unknown>;
    enableThinking?: boolean;
    signal?: AbortSignal;
    /**
     * Cap on the completion, in tokens (OpenAI's `max_tokens`). Absent leaves
     * the server's default alone. Named to match `chatStream`'s `maxTokens`,
     * which is what `OllamaService` already threads through on that path.
     */
    maxTokens?: number;
    /** Deadline for the response, in ms; absent uses `llm.firstResponseTimeoutMs`. */
    timeoutMs?: number;
  }): Promise<ChatResponse> {
    // Converted once, since a refused attempt is sent again and the conversion base64-encodes images.
    const messages = toOpenAiMessages(request.messages);
    const tools = request.tools && request.tools.length > 0 ? toOpenAiTools(request.tools) : undefined;
    const create = (format: ResponseFormat | undefined, thinking: ReturnType<typeof thinkingBody>) =>
      this.client.chat.completions.create(
        {
          model: request.model,
          messages,
          ...(tools && { tools }),
          ...(format && { response_format: format }),
          ...(request.maxTokens != null && request.maxTokens > 0 && { max_tokens: request.maxTokens }),
          ...thinking,
        },
        {
          signal: request.signal,
          timeout: request.timeoutMs ?? config.llm.firstResponseTimeoutMs,
          maxRetries: 0,
        },
      );

    let format = toResponseFormat(request.format, this.jsonSchemaRejected);
    let response: Awaited<ReturnType<typeof create>>;

    // At most one retry per kind of refusal: each retry drops the field that was refused, so the
    // loop cannot run more than three times.
    for (;;) {
      // Built per attempt. A refusal is retried when this attempt sent the field, which a call
      // already in flight when another call set the flag did too.
      const thinking = thinkingBody(request.enableThinking, this.reasoningEffortRejected);

      try {
        response = await create(format, thinking);
        break;
      } catch (err) {
        if (format?.type === 'json_schema' && isResponseFormatRejection(err)) {
          // Remembered for this driver's life (one per configured endpoint), so a backend without
          // schema support costs one rejected request, not one per structured call.
          this.jsonSchemaRejected = true;
          format = { type: 'json_object' };
        } else if (thinking.reasoning_effort !== undefined && isReasoningEffortRejection(err)) {
          // The same for a backend that validates `reasoning_effort` and refuses "none".
          this.reasoningEffortRejectedAt = Date.now();
        } else {
          throw err;
        }
      }
    }

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
    // Markup is a tool call only when tools were offered. Without them the text is an answer,
    // and markup in it is something the model quoted; it is still kept out of the content.
    const offeredTools = Boolean(request.tools && request.tools.length > 0);
    const toolCalls = structured.length > 0 ? structured : offeredTools ? salvaged.toolCalls : [];
    // Stripped on sight, as `chatStream` does: a quoted block mid-answer is no longer salvaged, so
    // keying the strip on salvaged calls left it in the reply as text that reads like a call.
    const content =
      toolCalls.length > 0 || hasToolMarkup(rawContent) ? stripToolMarkup(rawContent) : rawContent;

    return toChatResponse(request.model, {
      content,
      toolCalls,
      done: true,
      usage: response.usage,
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
     * Buffer the text and strip any tool markup from it, but emit no tool
     * calls at all — not the engine's structured ones, not salvaged ones. The
     * forced prose round: its answer is final, so a call the model still
     * emits is dropped, and this keeps the markup from reaching the viewer as
     * text. Measured 2026-09-30 on Lemonade: the model was told tool use was
     * over, apologised for a bad argument, and streamed a fresh
     * `<tool_call>…</tool_call>` block which the chat showed verbatim.
     */
    discardToolMarkup?: boolean;
    /**
     * Cap on the completion, in tokens. Unlike Ollama's `num_ctx` this bounds
     * only the answer — the prompt is bounded upstream by the context budget's
     * admission pass. Absent leaves the server's default alone.
     */
    maxTokens?: number;
  }): AsyncGenerator<ChatResponse> {
    const messages = toOpenAiMessages(request.messages);
    const tools = request.tools && request.tools.length > 0 ? toOpenAiTools(request.tools) : undefined;
    const open = (thinking: ReturnType<typeof thinkingBody>) =>
      this.client.chat.completions.create(
        {
          model: request.model,
          messages,
          stream: true,
          ...(tools && { tools }),
          ...(request.maxTokens != null && request.maxTokens > 0 && { max_tokens: request.maxTokens }),
          ...thinking,
        },
        { signal: request.signal, timeout: config.llm.firstResponseTimeoutMs, maxRetries: 0 },
      );
    const firstThinking = thinkingBody(request.enableThinking, this.reasoningEffortRejected);
    let stream: Awaited<ReturnType<typeof open>>;

    try {
      stream = await open(firstThinking);
    } catch (err) {
      // Keyed on what this request sent, as in chat(), so a stream opened before the flag was set
      // still retries.
      if (firstThinking.reasoning_effort === undefined || !isReasoningEffortRejection(err)) {
        throw err;
      }

      // See chat(): a backend that refuses `reasoning_effort: "none"` is asked without it from now on.
      this.reasoningEffortRejectedAt = Date.now();
      stream = await open(thinkingBody(request.enableThinking, true));
    }

    // Streamed tool calls arrive fragmented: an entry with id+name at some
    // index, then argument string fragments for that index. Accumulate by index.
    const pendingToolCalls = new Map<number, { name: string; argumentChunks: string[] }>();
    const contentChunks: string[] = [];
    // Buffer text whenever this chat may emit tool markup — including follow-up
    // turns that no longer advertise tools. Streaming `<toolcall>` as TEXT is
    // what made Confirm-home look like a successful call.
    const bufferContent =
      Boolean(request.tools && request.tools.length > 0) ||
      request.salvageTools === true ||
      request.discardToolMarkup === true;

    // The `usage` block, when the backend sends one: it rides a final chunk with no choices. Not
    // requested (`stream_options` is not sent), so a backend that does not volunteer it still
    // reports zero, as before.
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined;

    try {
      for await (const part of stream) {
        usage = part.usage ?? usage;

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
    // Salvaged markup becomes a call only when the caller asked for salvage, which it does only in
    // a round that offered tools.
    const emitted =
      structured.length > 0 ? structured : request.salvageTools === true ? salvaged.toolCalls : [];
    const toolCalls = request.discardToolMarkup ? [] : emitted;
    const prose = emitted.length > 0 || hasToolMarkup(rawContent) ? stripToolMarkup(rawContent) : rawContent;

    if (bufferContent && prose.trim() !== '') {
      yield toChatResponse(request.model, { content: prose, done: false });
    }

    if (toolCalls.length > 0) {
      yield toChatResponse(request.model, { toolCalls, done: false });
    }

    yield toChatResponse(request.model, { done: true, usage });
  }
}

/** Assemble an Ollama-`ChatResponse`-shaped chunk from the given parts. */
function toChatResponse(
  model: string,
  parts: {
    content?: string;
    thinking?: string;
    toolCalls?: ToolCall[];
    done: boolean;
    /** The OpenAI `usage` block, when the backend sent one. */
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  },
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
    prompt_eval_count: parts.usage?.prompt_tokens ?? 0,
    prompt_eval_duration: 0,
    eval_count: parts.usage?.completion_tokens ?? 0,
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
        ...message.images.map((image): ChatCompletionContentPart => ({
          type: 'image_url',
          image_url: { url: toDataUrl(image) },
        })),
      ];

      converted.push({ role: 'user', content: parts });

      continue;
    }

    converted.push({
      role: message.role as 'system' | 'user' | 'assistant',
      content: message.content ?? '',
    });
  }

  return mergeAdjacentTurns(hoistSystemMessages(converted));
}

/**
 * Join neighbouring plain-text turns of the same role into one. Qwen's chat
 * template as llama.cpp (so Lemonade) renders it refuses a transcript whose
 * last two messages are both assistant turns — `400 Cannot have 2 or more
 * assistant messages at the end of the list` — and the thread-title job sends
 * exactly that, because it keeps every assistant row of a tool turn and drops
 * the tool rows between them. Ollama's template never minded. Only text turns
 * are joined: an assistant turn carrying tool calls, a tool result, and a
 * user turn with images keep their own positions.
 */
function mergeAdjacentTurns(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const merged: ChatCompletionMessageParam[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    const joinable =
      previous != null &&
      previous.role === message.role &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof previous.content === 'string' &&
      typeof message.content === 'string' &&
      !('tool_calls' in previous && previous.tool_calls) &&
      !('tool_calls' in message && message.tool_calls);

    if (joinable) {
      merged[merged.length - 1] = {
        ...previous,
        content: [previous.content, message.content].filter((part) => part !== '').join('\n\n'),
      };
      continue;
    }

    merged.push(message);
  }

  return merged;
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

/** Whether `content` opens any tool-call markup the salvager reads, finished or not. */
function hasToolMarkup(content: string): boolean {
  return /<tool_?call\b|<function=/i.test(content);
}

/** A `<tool_call>` / `<toolcall>` block, closed or running to the end of the text. */
const TOOL_CALL_BLOCK = /<tool_?call\b[^>]*>([\s\S]*?)(?:<\/tool_?call>|$)/gi;

/** A bare `<function=name>` block, closed or running to the end of the text. */
const FUNCTION_BLOCK = /<function\s*=\s*([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/gi;

/**
 * Whether a markup block was finished, rather than opened in passing and run to the end of the
 * text by the regex. A `<tool_call>` counts as finished when it closes, when only a cut-off
 * closing tag ends the text (`</toolcall`, which Qwen on vLLM emits), when its function block
 * closes, or when it is a qwen3_coder name line followed by nothing but a JSON object. A bare
 * function block counts only when it closes.
 */
function isFinishedBlock(block: RegExpMatchArray, wrapped: boolean): boolean {
  const text = block[0];

  if (!wrapped) {
    return /<\/function>$/i.test(text);
  }

  const inner = block[1] ?? '';

  if (/<\/tool_?call\s*>?\s*$/i.test(text) || /<\/function>$/i.test(inner.trim())) {
    return true;
  }

  const [name, ...rest] = inner.trim().split('\n');

  if (!name || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name.trim())) {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(rest.join('\n'));

    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * The blocks a reply opens or closes with, as opposed to blocks sitting inside its prose.
 *
 * A model that calls a tool through text writes the markup as its whole reply, or leads with it,
 * or ends on it after a line such as "Let me record this." It does not write it in the middle of
 * an answer. Markup in the middle of an answer is a quote: an email subject or invite title the
 * model repeated while reporting on it. Running that as a tool call would let whoever wrote the
 * email choose the call, so only the leading run of blocks and the trailing run count, each
 * separated from the next by whitespace alone.
 */
function standaloneBlocks(content: string, blocks: RegExpMatchArray[]): Set<number> {
  const blank = (from: number, to: number) => content.slice(from, to).trim() === '';
  const accepted = new Set<number>();

  let cursor = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const start = blocks[index].index ?? 0;

    if (!blank(cursor, start)) {
      break;
    }

    accepted.add(index);
    cursor = start + blocks[index][0].length;
  }

  cursor = content.length;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const start = blocks[index].index ?? 0;

    if (!blank(start + blocks[index][0].length, cursor)) {
      break;
    }

    accepted.add(index);
    cursor = start;
  }

  return accepted;
}

/**
 * Lift Qwen/vLLM tool markup out of assistant text. Ollama already returns
 * structured `tool_calls`; vLLM with `--tool-call-parser qwen3_coder` often
 * does not, and the model writes `<toolcall><function=name>…` into content
 * instead. Same loop in OllamaService executes either shape.
 *
 * Only finished blocks that open or close the reply become calls (see
 * {@link standaloneBlocks}); markup anywhere else is stripped from the prose
 * and never run. Callers salvage only in a round that offered tools.
 */
export function extractEmbeddedToolCalls(content: string): { prose: string; toolCalls: ToolCall[] } {
  if (!content || !hasToolMarkup(content)) {
    return { prose: content, toolCalls: [] };
  }

  const toolCalls: ToolCall[] = [];

  const consumeFunctions = (block: string) => {
    const closed = [...block.matchAll(FUNCTION_BLOCK)];
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

  const wrapped = [...content.matchAll(TOOL_CALL_BLOCK)];
  const blocks = wrapped.length > 0 ? wrapped : [...content.matchAll(FUNCTION_BLOCK)];
  const standalone = standaloneBlocks(content, blocks);

  blocks.forEach((block, index) => {
    if (!standalone.has(index) || !isFinishedBlock(block, wrapped.length > 0)) {
      return;
    }

    if (wrapped.length === 0) {
      consumeFunctions(block[0]);

      return;
    }

    const before = toolCalls.length;
    consumeFunctions(block[1]);
    if (toolCalls.length === before) {
      consumeQwenCoderBlock(block[1], toolCalls);
    }
  });

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
