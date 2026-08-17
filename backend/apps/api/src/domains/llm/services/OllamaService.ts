import { Injectable } from '@nestjs/common';
import {
  type ChatResponse,
  type GenerateResponse,
  type Message as OllamaMessage,
  type Tool,
  type ToolCall,
  Ollama,
} from 'ollama';

import type { RequestContext } from '@ci/common/context';
import { type ApiKeyCapability, FULL_CAPABILITY } from '@ci/common/decorators';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import {
  ToolRegistry,
  capabilityAllows,
  intentToolName,
  type ToolInvocationContext,
  type ToolSchema,
} from '@ci/domains/tools';

import type { OllamaModel } from '../types';

import { LlmEndpointService } from './LlmEndpointService';

/** Default model used for background inference tasks (extraction, Q&A, etc.). */
export const PROMPT_MODEL = config.llm.chatModel;
const DEMO_VISION_MODEL = 'gemma3:27b';
const DEMO_TEXT_MODEL = 'qwen3:14b';
const INTERNAL_MODELS = new Set(['nomic-embed-text', 'nomic-embed-text-v2-moe']);

const OPENAI_MODE_CAPABILITIES = ['completion', 'tools'];

function chatChunkToGenerateResponse(chunk: ChatResponse): GenerateResponse {
  return {
    model: chunk.model,
    created_at: chunk.created_at,
    response: chunk.message.content,
    done: chunk.done,
    done_reason: chunk.done_reason,
    context: [],
    total_duration: chunk.total_duration,
    load_duration: chunk.load_duration,
    prompt_eval_count: chunk.prompt_eval_count,
    prompt_eval_duration: chunk.prompt_eval_duration,
    eval_count: chunk.eval_count,
    eval_duration: chunk.eval_duration,
  };
}

/**
 * A request context that may also carry the **authority of the principal driving the chat**.
 *
 * Tool calls made from a chat turn are made on behalf of whoever opened that chat, and the model
 * choosing to call `memory.forget` does not grant authority the caller never had. This is how the
 * caller's capability reaches {@link ToolRegistry.executeTool} — which is where it is enforced.
 *
 * Optional so the many in-process callers (`persona`, `schedule`, the listeners) that pass a bare
 * `RequestContext` keep compiling: every one of them passes `enableTools: false` and is the
 * appliance acting as itself, which is full authority. {@link resolveInvocationCapability} makes
 * that reading explicit rather than accidental.
 */
export interface ChatRequestContext extends RequestContext {
  capability?: ApiKeyCapability;
}

/**
 * The authority a chat turn's tool calls run with.
 *
 * Absent means "not an outside caller" — the same reading `apiKeyCapabilityOf` gives a session:
 * a background job or an internal service is the appliance acting on its own behalf. Any surface
 * that accepts an outside request MUST set it (see OllamaController, which reads it off the
 * express request); leaving it unset there is what the ungated-LLM-path bug was.
 */
function resolveInvocationCapability(context: ChatRequestContext): ApiKeyCapability {
  return context.capability ?? FULL_CAPABILITY;
}

interface PromptOptions {
  model: string;
  signal?: AbortSignal;
  enableTools?: boolean;
  enableThinking?: boolean;
  /**
   * `'json'` asks for syntactically valid JSON and nothing more — the model is
   * still free to invent key names, which small models reliably do. A JSON
   * Schema object instead constrains generation to that shape via grammar, so
   * the caller gets the fields it asked for rather than valid-but-unusable
   * JSON. Prefer the schema form for anything that will be parsed.
   */
  format?: string | Record<string, unknown>;
}

interface ValidateModelOptions {
  messages?: OllamaMessage[];
  requestedModel?: string | null;
  enableThinking?: boolean;
  enableTools?: boolean;
}

interface ValidateModelResult {
  model: string;
  enableThinking: boolean;
  enableTools: boolean;
}

/**
 * Settle with `promise`, or reject the moment `signal` aborts — whichever comes
 * first. Without a signal the promise is handed back untouched, so a caller that
 * passes none is completely unaffected.
 *
 * Racing is the only way to honour a signal on a non-streaming request: the
 * ollama client builds its own AbortController on the STREAMING path only, and
 * posts a one-shot request with no signal at all, so there is nothing for it to
 * cancel. The socket is left to the runtime; what the race buys is that the
 * caller stops waiting on a host that is down or a model still loading.
 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Aborted'));

    if (signal.aborted) {
      onAbort();

      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    // Attaching a rejection handler here also keeps a late failure on an
    // already-abandoned request from surfacing as an unhandled rejection.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

@Injectable()
export class OllamaService {
  constructor(
    private readonly llmEndpointService: LlmEndpointService,
    private readonly toolRegistry: ToolRegistry,
    private readonly logger: LoggerService,
    private readonly featureService: FeatureService,
  ) {
    this.logger.setContext(OllamaService.name);
  }

  private get ollama(): Ollama {
    return new Ollama({ host: this.llmEndpointService.getOllamaHost() });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getAvailableModels(context: RequestContext): Promise<OllamaModel[]> {
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    if (openAiDriver) {
      const modelIds = await openAiDriver.listModels();

      return modelIds
        .map((id) => this.parseOllamaModel(id))
        .filter((model) => !INTERNAL_MODELS.has(model.name))
        .map((model) => ({
          ...model,
          capabilities: OPENAI_MODE_CAPABILITIES,
          vision: false,
          tools: true,
          thinking: false,
        }));
    }

    const result = await this.ollama.list();
    const models = result.models.map((model) => this.parseOllamaModel(model.name));
    const visibleModels = models.filter((model) => !INTERNAL_MODELS.has(model.name));

    return await Promise.all(
      visibleModels.map(async (model) => {
        const capabilities = await this.fetchModelCapabilities(model.model, {
          throwOnError: false,
        });

        return {
          ...model,
          capabilities,
          vision: capabilities.includes('vision'),
          tools: capabilities.includes('tools'),
          thinking: capabilities.includes('thinking'),
        };
      }),
    );
  }

  async getModelCapabilities(context: RequestContext, requestedModel: string): Promise<string[]> {
    await this.validateModel(context, requestedModel);

    return await this.fetchModelCapabilities(requestedModel);
  }

  async generateStream(
    context: RequestContext,
    prompt: string,
    { model, signal }: PromptOptions,
  ): Promise<AsyncGenerator<GenerateResponse> & { buffer: string }> {
    const chunks: string[] = [];
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    const stream = (async function* (self) {
      if (openAiDriver) {
        const iterator = openAiDriver.chatStream({
          model,
          messages: [{ role: 'user', content: prompt }],
          signal,
        });

        for await (const chunk of iterator) {
          if (chunk.message.content) {
            chunks.push(chunk.message.content);
          }

          yield chatChunkToGenerateResponse(chunk);
        }

        return;
      }

      const iterator = await self.ollama.generate({
        model,
        prompt,
        stream: true,
      });

      signal?.addEventListener('abort', () => {
        iterator.abort();
      });

      for await (const chunk of iterator) {
        if (chunk && !!chunk.response) {
          chunks.push(chunk.response);
        }

        yield chunk;
      }
    })(this);

    Object.defineProperty(stream, 'buffer', {
      enumerable: true,
      get: () => chunks.join(''),
    });

    return stream as typeof stream & { buffer: string };
  }

  async generate(
    context: RequestContext,
    prompt: string,
    { model }: Omit<PromptOptions, 'signal'>,
  ): Promise<GenerateResponse> {
    await this.validateModel(context, model);

    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    if (openAiDriver) {
      const response = await openAiDriver.chat({
        model,
        messages: [{ role: 'user', content: prompt }],
      });

      return chatChunkToGenerateResponse(response);
    }

    return this.ollama.generate({
      model,
      prompt,
    });
  }

  async chatStream(
    context: ChatRequestContext,
    messages: OllamaMessage[],
    { model, signal, enableTools = false, enableThinking = true }: PromptOptions,
  ): Promise<AsyncGenerator<ChatResponse> & { messages: OllamaMessage[] }> {
    await this.validateModel(context, model);

    const inputMessages = messages.slice();
    const availableTools = enableTools ? this.toolsWithinCapability(context) : [];
    const ollamaTools: Tool[] = availableTools.map(this.convertToOllamaTool);
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    const textChunks: string[] = [];
    const thinkChunks: string[] = [];
    const toolCalls: ToolCall[] = [];
    const accumulatedMessages: OllamaMessage[] = [];

    const stream = (async function* (self) {
      do {
        if (signal?.aborted) {
          break;
        }

        let lastChunk: ChatResponse | undefined;
        let handleAbort = () => {};

        textChunks.splice(0, textChunks.length);
        thinkChunks.splice(0, thinkChunks.length);

        const iterationToolCalls = toolCalls.splice(0, toolCalls.length);
        const toolEvaluations = await self.handleToolCalls(context, iterationToolCalls);

        accumulatedMessages.push(...toolEvaluations);

        const iterationWillCallTools = enableTools && ollamaTools.length > 0 && toolEvaluations.length === 0;

        try {
          if (openAiDriver) {
            const iterator = openAiDriver.chatStream({
              model,
              messages: inputMessages.concat(accumulatedMessages),
              tools: iterationWillCallTools ? ollamaTools : undefined,
              signal,
            });

            for await (const chunk of iterator) {
              lastChunk = chunk;

              if (chunk.message.content) {
                textChunks.push(chunk.message.content);
              }

              if (chunk.message.thinking) {
                thinkChunks.push(chunk.message.thinking);
              }

              if (chunk.message.tool_calls) {
                toolCalls.push(...chunk.message.tool_calls);
              }

              yield chunk;
            }
          } else {
            const iterator = await self.ollama.chat({
              model,
              messages: inputMessages.concat(accumulatedMessages),
              stream: true,
              ...(enableThinking && { think: true }),
              ...(iterationWillCallTools && { tools: ollamaTools }),
            });

            handleAbort = () => iterator.abort();

            signal?.addEventListener('abort', handleAbort);

            for await (const chunk of iterator) {
              lastChunk = chunk;

              if (chunk.message.content) {
                textChunks.push(chunk.message.content);
              }

              if (chunk.message.thinking) {
                thinkChunks.push(chunk.message.thinking);
              }

              if (chunk.message.tool_calls) {
                toolCalls.push(...chunk.message.tool_calls);
              }

              yield chunk;
            }
          }

          if (lastChunk?.done) {
            self.logger.log('LLM prompt evaluation completed', {
              model: lastChunk.model,
              totalDuration: lastChunk.total_duration ? lastChunk.total_duration / 1_000_000 : undefined,
              loadDuration: lastChunk.load_duration ? lastChunk.load_duration / 1_000_000 : undefined,
              evalDuration: lastChunk.prompt_eval_duration
                ? lastChunk.prompt_eval_duration / 1_000_000
                : undefined,
              promptCount: lastChunk.prompt_eval_count,
              evalCount: lastChunk.eval_count,
              doneReason: lastChunk.done_reason,
            });
          }
        } catch (err) {
          if (!(err instanceof DOMException && err.name === 'AbortError')) {
            const error = err as Error;

            self.logger.error('LLM prompt evaluation completed', {
              model: lastChunk?.model ?? model,
              doneReason: 'error',
              errorMessage: error?.message ?? String(err),
              errorStack: error instanceof Error ? error.stack : undefined,
            });

            break;
          }
        } finally {
          const think = thinkChunks.join('');
          const content = textChunks.join('');

          const message = {
            role: 'assistant',
            content: (think ? `<think>${think}</think>` : '') + content,
            ...(toolCalls.length > 0 && { tool_calls: toolCalls.slice() }),
          } satisfies OllamaMessage;

          accumulatedMessages.push(message);

          signal?.removeEventListener('abort', handleAbort);

          if (signal?.aborted) {
            self.logger.log('LLM prompt evaluation completed', {
              model: lastChunk?.model ?? model,
              doneReason: 'canceled',
            });
          }
        }
      } while (toolCalls.length > 0);
    })(this);

    Object.defineProperty(stream, 'messages', {
      enumerable: true,
      get: () => accumulatedMessages,
    });

    return stream as typeof stream & { messages: OllamaMessage[] };
  }

  /**
   * `signal` is optional and additive: it now bounds the whole call — the model
   * lookup included, since that is its own round trip to a host that may be
   * down — rather than being dropped from the parameter type as it used to be.
   */
  async chat(
    context: ChatRequestContext,
    messages: OllamaMessage[],
    options: PromptOptions,
  ): Promise<ChatResponse> {
    return abortable(this.runChat(context, messages, options), options.signal);
  }

  private async runChat(
    context: ChatRequestContext,
    messages: OllamaMessage[],
    { model, enableTools = false, format }: PromptOptions,
  ): Promise<ChatResponse> {
    await this.validateModel(context, model);

    const inputMessages = messages.slice();
    const availableTools = enableTools ? this.toolsWithinCapability(context) : [];
    const ollamaTools: Tool[] = availableTools.map(this.convertToOllamaTool);
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();
    // vLLM / OpenAI-compat only honors `format: 'json'` (json_object). A JSON
    // Schema object is still useful on the native Ollama path; collapse it here
    // so structured callers still get JSON rather than prose.
    const openAiFormat = typeof format === 'string' ? format : format != null ? 'json' : undefined;

    const accumulatedMessages: OllamaMessage[] = [];

    const response = openAiDriver
      ? await openAiDriver.chat({
          model,
          messages: inputMessages,
          tools: enableTools && ollamaTools.length > 0 ? ollamaTools : undefined,
          format: openAiFormat,
        })
      : await this.ollama.chat({
          model: model,
          messages: inputMessages,
          ...(format && { format }),
          ...(enableTools && ollamaTools.length > 0 && { tools: ollamaTools }),
        });

    const willCallTools =
      enableTools && response.message.tool_calls && response.message.tool_calls.length > 0;

    accumulatedMessages.push({
      role: response.message.role,
      content: response.message.content,
      ...(willCallTools && { tool_calls: response.message.tool_calls }),
    } satisfies OllamaMessage);

    if (!willCallTools) {
      return response;
    }

    const toolEvaluations = await this.handleToolCalls(context, response.message.tool_calls ?? []);

    accumulatedMessages.push(...toolEvaluations);

    if (openAiDriver) {
      return openAiDriver.chat({
        model,
        messages: inputMessages.concat(accumulatedMessages),
        tools: enableTools && ollamaTools.length > 0 ? ollamaTools : undefined,
        format: openAiFormat,
      });
    }

    return this.ollama.chat({
      model,
      messages: inputMessages.concat(accumulatedMessages),
    });
  }

  async resolveModel(context: RequestContext, opts?: ValidateModelOptions): Promise<ValidateModelResult> {
    const { messages = [], requestedModel, enableThinking = false, enableTools = false } = opts ?? {};

    let resolvedModel = requestedModel ?? PROMPT_MODEL;
    let resolvedThinking = enableThinking;
    let resolvedTools = enableTools;

    const pinnedDemoModelsEnabled = await this.featureService.isFeatureEnabled('pinned.demo.models');

    if (pinnedDemoModelsEnabled) {
      const hasVisualContent = messages.some((message) => message.images && message.images.length > 0);

      resolvedModel = hasVisualContent ? DEMO_VISION_MODEL : DEMO_TEXT_MODEL;
      resolvedThinking = hasVisualContent ? false : true;
      resolvedTools = hasVisualContent ? false : true;
    }

    await this.validateModel(context, resolvedModel);

    return {
      model: resolvedModel,
      enableThinking: resolvedThinking,
      enableTools: resolvedTools,
    };
  }

  private parseOllamaModel(model: string): OllamaModel {
    const [fullName, tag = 'latest'] = model.split(':');
    const parts = fullName.split('/');

    if (parts.length === 2) {
      const [namespace, name] = parts;

      return {
        model,
        namespace,
        name,
        tag,
      };
    }

    return {
      model,
      namespace: null,
      name: parts[0],
      tag,
    };
  }

  /**
   * The tools to advertise to the model for this caller.
   *
   * Mirrors what MCP's `getToolsForRequest` does for its catalog: do not offer a read-only caller
   * a delete it will be refused. This is presentation, not enforcement — the model can name any
   * tool it likes regardless of what it was shown, which is why the registry re-checks — but a
   * model handed a catalog whose entries fail is a model that retries them.
   */
  private toolsWithinCapability(context: ChatRequestContext): ToolSchema[] {
    const capability = resolveInvocationCapability(context);

    return this.toolRegistry
      .getAgentFacingTools(context)
      .filter((schema) => capabilityAllows(schema.privacy, capability));
  }

  private async handleToolCalls(
    context: ChatRequestContext,
    toolCalls: ToolCall[],
  ): Promise<OllamaMessage[]> {
    if (toolCalls.length === 0) {
      this.logger.debug('No tool calls to evaluate, skipping handling', {
        userId: context.userId,
      });

      return [];
    }

    this.logger.debug('Processing tool calls', {
      toolCallCount: toolCalls.length,
      toolNames: toolCalls.map((tc) => tc.function.name),
      userId: context.userId,
    });

    // The name and arguments below came out of a language model that was reading user-supplied
    // text, so they are attacker-influenced input, not a decision the caller made. The capability
    // carried here is what bounds them: the registry refuses anything above it.
    const invocationContext: ToolInvocationContext = {
      ...context,
      capability: resolveInvocationCapability(context),
    };

    const toolResults = await Promise.all(
      toolCalls.map(async (toolCall) => {
        const { name, arguments: args } = toolCall.function;

        try {
          const result = await this.toolRegistry.executeTool(name, invocationContext, args);

          return {
            call: toolCall,
            result: result.success ? result.data : { error: result.error },
            success: result.success,
          };
        } catch (error) {
          this.logger.error('Tool execution failed', {
            toolName: name,
            error: error instanceof Error ? error.message : String(error),
            userId: context.userId,
          });

          return {
            call: toolCall,
            result: { error: 'Tool execution failed' },
            success: false,
          };
        }
      }),
    );

    return toolResults.map(
      ({ result }) =>
        ({
          role: 'tool' as const,
          content: JSON.stringify(result),
        }) satisfies OllamaMessage,
    );
  }

  private convertToOllamaTool(toolSchema: ToolSchema): Tool {
    return {
      type: 'function',
      function: {
        name: intentToolName(toolSchema.name),
        description: toolSchema.description,
        parameters: toolSchema.parameters,
      },
    };
  }

  private async validateModel(_context: RequestContext, requestedModel: string) {
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    if (openAiDriver) {
      const modelIds = await openAiDriver.listModels();

      if (!modelIds.includes(requestedModel)) {
        throw new Error(`Invalid model specified: ${requestedModel}`);
      }

      return;
    }

    const result = await this.ollama.list();
    const validModel = result.models.find((model) => model.name === requestedModel);

    if (!validModel) {
      throw new Error(`Invalid model specified: ${requestedModel}`);
    }
  }

  private async fetchModelCapabilities(
    requestedModel: string,
    options: { throwOnError?: boolean } = {},
  ): Promise<string[]> {
    const { throwOnError = true } = options;

    if (this.llmEndpointService.usesOpenAiDriver()) {
      return OPENAI_MODE_CAPABILITIES;
    }

    try {
      const response = (await this.ollama.show({ model: requestedModel })) as {
        capabilities?: unknown;
      };

      if (!Array.isArray(response.capabilities)) {
        return [];
      }

      return response.capabilities
        .filter((capability): capability is string => typeof capability === 'string')
        .map((capability) => capability.toLowerCase());
    } catch (error) {
      if (throwOnError) {
        throw error;
      }

      this.logger.warn('Failed to fetch Ollama model capabilities while listing models', {
        model: requestedModel,
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }
}
