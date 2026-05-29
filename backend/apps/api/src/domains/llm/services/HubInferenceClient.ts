import {
  type ChatRequest,
  type ChatResponse,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type GenerateRequest,
  type GenerateResponse,
  type ListResponse,
  type Message as OllamaMessage,
  type ToolCall,
} from 'ollama';
import OpenAI from 'openai';

import config from '@ci/configuration';

/**
 * The small subset of the `ollama` streaming iterator contract that the rest of
 * the codebase relies on: it must be async-iterable and abortable.
 *
 * We intentionally do NOT reuse ollama's `AbortableAsyncIterator` class here —
 * that class carries `private` members and is therefore nominal, so a structural
 * stand-in can never be assignable to it. Exposing our own shape keeps
 * `OllamaService` a near-no-op swap because it only ever calls `for await (...)`
 * and `iterator.abort()`.
 */
export interface AbortableStream<T> extends AsyncIterable<T> {
  abort(): void;
}

/**
 * OpenAI streaming deltas may surface model "thinking" under a couple of
 * non-standard keys depending on the upstream server. These are not part of the
 * typed OpenAI SDK surface, so we read them defensively.
 */
interface ReasoningDelta {
  reasoning_content?: string | null;
  reasoning?: string | null;
}

/**
 * Adapter that implements the slice of the `ollama` npm client interface used by
 * {@link OllamaService} and the embedding service, backed by the `openai` SDK
 * pointed at the CI Hub's OpenAI-compatible `/v1` proxy.
 *
 * The public method signatures and return shapes mirror the `ollama` client so
 * its consumers continue to operate on ollama-shaped objects unchanged.
 */
export class HubInferenceClient {
  private readonly client: OpenAI;

  constructor() {
    // Prefer the Hub's OpenAI proxy. Fall back to a local Ollama, which serves
    // an OpenAI-compatible API at `<host>/v1`, so the adapter keeps working when
    // the Hub provides no apiBase.
    const baseURL = config.llm.apiBase ?? `${config.services.ollama.host.replace(/\/+$/, '')}/v1`;
    const apiKey = config.llm.apiKey ?? 'ollama';

    this.client = new OpenAI({ baseURL, apiKey });
  }

  chat(request: ChatRequest & { stream: true }): Promise<AbortableStream<ChatResponse>>;

  chat(request: ChatRequest & { stream?: false }): Promise<ChatResponse>;

  async chat(request: ChatRequest): Promise<ChatResponse | AbortableStream<ChatResponse>> {
    const messages = this.toOpenAIMessages(request.messages ?? []);
    const tools = request.tools as OpenAI.ChatCompletionTool[] | undefined;
    const responseFormat = this.toResponseFormat(request.format);

    const body = {
      model: request.model,
      messages,
      ...(tools && tools.length > 0 && { tools, tool_choice: 'auto' as const }),
      ...(responseFormat && { response_format: responseFormat }),
    };

    if (request.stream) {
      const controller = new AbortController();
      const stream = await this.client.chat.completions.create(
        { ...body, stream: true },
        { signal: controller.signal },
      );

      return this.wrapAbortable(this.streamChat(stream, request.model), controller);
    }

    const completion = await this.client.chat.completions.create({ ...body, stream: false });
    const choice = completion.choices[0];
    const message = choice?.message;

    return {
      model: completion.model,
      created_at: new Date(completion.created * 1000),
      message: {
        role: message?.role ?? 'assistant',
        content: message?.content ?? '',
        ...(message?.tool_calls && message.tool_calls.length > 0
          ? { tool_calls: this.toOllamaToolCalls(message.tool_calls) }
          : {}),
      },
      done: true,
      done_reason: choice?.finish_reason ?? 'stop',
      total_duration: 0,
      load_duration: 0,
      prompt_eval_count: completion.usage?.prompt_tokens ?? 0,
      prompt_eval_duration: 0,
      eval_count: completion.usage?.completion_tokens ?? 0,
      eval_duration: 0,
    };
  }

  generate(request: GenerateRequest & { stream: true }): Promise<AbortableStream<GenerateResponse>>;

  generate(request: GenerateRequest & { stream?: false }): Promise<GenerateResponse>;

  async generate(request: GenerateRequest): Promise<GenerateResponse | AbortableStream<GenerateResponse>> {
    // The Hub proxy 404s `/v1/completions`, so `generate` is implemented on top
    // of chat.completions with a single user message.
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: request.prompt }];
    const body = { model: request.model, messages };

    if (request.stream) {
      const controller = new AbortController();
      const stream = await this.client.chat.completions.create(
        { ...body, stream: true },
        { signal: controller.signal },
      );

      return this.wrapAbortable(this.streamGenerate(stream, request.model), controller);
    }

    const completion = await this.client.chat.completions.create({ ...body, stream: false });
    const choice = completion.choices[0];

    return {
      model: completion.model,
      created_at: new Date(completion.created * 1000),
      response: choice?.message?.content ?? '',
      done: true,
      done_reason: choice?.finish_reason ?? 'stop',
      context: [],
      total_duration: 0,
      load_duration: 0,
      prompt_eval_count: completion.usage?.prompt_tokens ?? 0,
      prompt_eval_duration: 0,
      eval_count: completion.usage?.completion_tokens ?? 0,
      eval_duration: 0,
    };
  }

  async list(): Promise<ListResponse> {
    const models: ListResponse['models'] = [];

    const page = await this.client.models.list();

    for await (const model of page) {
      // OllamaService.parseOllamaModel only consumes `.name`; the rest of the
      // ModelResponse shape is filled with inert defaults to satisfy the type.
      models.push({
        name: model.id,
        model: model.id,
        modified_at: new Date(),
        size: 0,
        digest: '',
        details: {
          parent_model: '',
          format: '',
          family: '',
          families: [],
          parameter_size: '',
          quantization_level: '',
        },
        expires_at: new Date(),
        size_vram: 0,
      });
    }

    return { models };
  }

  /**
   * There is no OpenAI-compatible equivalent of Ollama's `show`. The controller
   * tolerates an empty capability list, so we return that. We optimistically
   * infer 'vision' when the model id hints at it.
   */
  async show({ model }: { model: string }): Promise<{ capabilities: string[] }> {
    const capabilities: string[] = [];

    if (/vision|llava|vl\b|multimodal/i.test(model)) {
      capabilities.push('vision');
    }

    return { capabilities };
  }

  async embeddings({ model, prompt }: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    const response = await this.client.embeddings.create({ model, input: prompt });

    return { embedding: response.data[0]?.embedding ?? [] };
  }

  /**
   * Convert ollama-shaped messages to OpenAI chat messages.
   *
   * Two pieces of correlation are handled here so {@link OllamaService} can stay
   * unchanged:
   *  - Assistant messages carrying ollama `tool_calls` (which have no ids) are
   *    assigned deterministic ids (`call_<n>`).
   *  - Subsequent `role:'tool'` messages — emitted by the tool loop in the SAME
   *    ORDER as the calls — are correlated to the most recent assistant
   *    tool_calls and given the matching `tool_call_id`.
   */
  private toOpenAIMessages(messages: OllamaMessage[]): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    // Ids of the most recent assistant tool_calls, in order, awaiting their
    // corresponding `role:'tool'` result messages.
    let pendingToolCallIds: string[] = [];
    let toolResultCursor = 0;
    let toolCallCounter = 0;

    for (const message of messages) {
      const role = message.role;

      if (role === 'assistant') {
        const toolCalls = message.tool_calls ?? [];

        if (toolCalls.length > 0) {
          const ids = toolCalls.map(() => `call_${toolCallCounter++}`);

          pendingToolCallIds = ids;
          toolResultCursor = 0;

          result.push({
            role: 'assistant',
            content: message.content ?? '',
            tool_calls: toolCalls.map((toolCall, index) => ({
              id: ids[index],
              type: 'function',
              function: {
                name: toolCall.function.name,
                arguments: JSON.stringify(toolCall.function.arguments ?? {}),
              },
            })),
          });
        } else {
          result.push({ role: 'assistant', content: message.content ?? '' });
        }

        continue;
      }

      if (role === 'tool') {
        // Correlate by order to the most recent assistant tool_calls. If we run
        // out of pending ids (e.g. unbalanced history), fall back to a synthetic
        // id so the OpenAI server still receives a well-formed tool message.
        // TODO(live-validate): confirm ordering holds for multi-tool-call turns
        // against a real Hub+Ollama; single-tool-call turns are exercised here.
        const toolCallId = pendingToolCallIds[toolResultCursor] ?? `call_${toolResultCursor}`;

        toolResultCursor += 1;

        result.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: message.content ?? '',
        });

        continue;
      }

      if (role === 'system') {
        result.push({ role: 'system', content: message.content ?? '' });

        continue;
      }

      // Default: user message. Build multimodal content when images are present.
      result.push({ role: 'user', content: this.toUserContent(message) });
    }

    return result;
  }

  private toUserContent(message: OllamaMessage): string | OpenAI.ChatCompletionContentPart[] {
    const text = message.content ?? '';

    if (!message.images || message.images.length === 0) {
      return text;
    }

    const parts: OpenAI.ChatCompletionContentPart[] = [{ type: 'text', text }];

    for (const image of message.images) {
      // ollama accepts either base64 strings or raw bytes; the file pipeline
      // here hands us Uint8Array, so normalise both to a base64 data URI.
      // TODO(live-validate): jpeg is assumed for the mime type — verify against
      // real captured image formats.
      const base64 = typeof image === 'string' ? image : Buffer.from(image).toString('base64');

      parts.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${base64}` },
      });
    }

    return parts;
  }

  /**
   * Map ollama's `format` to OpenAI's `response_format`. Ollama uses the string
   * `'json'` for free-form JSON mode and a raw JSON Schema object for structured
   * output; OpenAI expects `{ type: 'json_object' }` and `{ type: 'json_schema',
   * json_schema: {...} }` respectively.
   */
  private toResponseFormat(
    format: ChatRequest['format'],
  ): OpenAI.ChatCompletionCreateParams['response_format'] | undefined {
    if (!format) {
      return undefined;
    }

    if (format === 'json') {
      return { type: 'json_object' };
    }

    if (typeof format === 'object') {
      // TODO(live-validate): ollama accepts a bare JSON Schema; OpenAI wants it
      // wrapped under json_schema.schema with a name. This shim is untested
      // against the Hub proxy's structured-output support.
      return {
        type: 'json_schema',
        json_schema: { name: 'response', schema: format as Record<string, unknown> },
      };
    }

    return undefined;
  }

  private toOllamaToolCalls(toolCalls: OpenAI.ChatCompletionMessageToolCall[]): ToolCall[] {
    return toolCalls.map((toolCall) => ({
      function: {
        name: toolCall.function.name,
        arguments: this.parseArguments(toolCall.function.arguments),
      },
    }));
  }

  private parseArguments(raw: string | undefined): Record<string, unknown> {
    if (!raw) {
      return {};
    }

    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async *streamChat(
    stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
    fallbackModel: string,
  ): AsyncGenerator<ChatResponse> {
    // Accumulate streamed tool-call deltas per `index`; OpenAI sends `name` and
    // `id` early and `arguments` as partial JSON fragments across chunks.
    const toolCallAccumulator = new Map<number, { id?: string; name?: string; arguments: string }>();

    let model = fallbackModel;

    for await (const chunk of stream) {
      model = chunk.model || model;

      const choice = chunk.choices[0];
      const delta = choice?.delta;
      const finishReason = choice?.finish_reason ?? null;

      if (delta?.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          const entry = toolCallAccumulator.get(toolCallDelta.index) ?? { arguments: '' };

          if (toolCallDelta.id) {
            entry.id = toolCallDelta.id;
          }

          if (toolCallDelta.function?.name) {
            entry.name = toolCallDelta.function.name;
          }

          if (toolCallDelta.function?.arguments) {
            entry.arguments += toolCallDelta.function.arguments;
          }

          toolCallAccumulator.set(toolCallDelta.index, entry);
        }
      }

      const reasoning = delta as ReasoningDelta | undefined;
      const thinking = reasoning?.reasoning_content ?? reasoning?.reasoning ?? undefined;

      // Emit the assembled tool_calls only on the finishing chunk.
      const toolCalls =
        finishReason && toolCallAccumulator.size > 0
          ? this.assembleToolCalls(toolCallAccumulator)
          : undefined;

      const done = finishReason != null;

      yield {
        model,
        created_at: new Date(chunk.created * 1000),
        message: {
          role: 'assistant',
          content: delta?.content ?? '',
          ...(thinking ? { thinking } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        done,
        done_reason: finishReason ?? '',
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: 0,
        prompt_eval_duration: 0,
        eval_count: 0,
        eval_duration: 0,
      };
    }
  }

  private async *streamGenerate(
    stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
    fallbackModel: string,
  ): AsyncGenerator<GenerateResponse> {
    let model = fallbackModel;

    for await (const chunk of stream) {
      model = chunk.model || model;

      const choice = chunk.choices[0];
      const finishReason = choice?.finish_reason ?? null;
      const done = finishReason != null;

      yield {
        model,
        created_at: new Date(chunk.created * 1000),
        response: choice?.delta?.content ?? '',
        done,
        done_reason: finishReason ?? '',
        context: [],
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: 0,
        prompt_eval_duration: 0,
        eval_count: 0,
        eval_duration: 0,
      };
    }
  }

  private assembleToolCalls(
    accumulator: Map<number, { id?: string; name?: string; arguments: string }>,
  ): ToolCall[] {
    return [...accumulator.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => ({
        function: {
          name: entry.name ?? '',
          arguments: this.parseArguments(entry.arguments),
        },
      }));
  }

  private wrapAbortable<T>(iterator: AsyncGenerator<T>, controller: AbortController): AbortableStream<T> {
    return {
      abort: () => controller.abort(),
      [Symbol.asyncIterator]: () => iterator,
    };
  }
}
