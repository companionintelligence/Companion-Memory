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
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { ToolRegistry, intentToolName, type ToolSchema } from '@ci/domains/tools';

import type { OllamaModel } from '../types';

import { OpenAiCompatChatDriver } from './OpenAiCompatChatDriver';

/** Default model used for background inference tasks (extraction, Q&A, etc.).
 *  Import this constant rather than hardcoding the model name. Hub-injected
 *  deployments override it via LLM_DEFAULT_CHAT_MODEL (config `llm.chatModel`);
 *  plain-Ollama deploys fall back to the schema default (gemma3:1b). */
export const PROMPT_MODEL = config.llm.chatModel;
const DEMO_VISION_MODEL = 'gemma3:27b';
const DEMO_TEXT_MODEL = 'qwen3:14b';
const INTERNAL_MODELS = new Set(['nomic-embed-text', 'nomic-embed-text-v2-moe']);

/**
 * Capabilities advertised for models served by a generic OpenAI-compatible
 * backend. The OpenAI protocol has no `ollama show` equivalent, so we assume
 * chat + tools (both are baseline protocol features; vLLM etc. accept the
 * `tools` parameter) and leave vision/thinking off — those need per-model
 * metadata we don't have.
 */
const OPENAI_MODE_CAPABILITIES = ['completion', 'tools'];

/**
 * The OpenAI driver is only engaged when LLM_API_BASE points somewhere other
 * than the configured Ollama instance. When it's unset, or aims at Ollama's
 * own /v1 surface, the native client is used so Ollama-only features (thinking
 * stream, `show` capabilities, keep-alive semantics) keep working.
 */
/** Reshape a chat completion into Ollama's generate-endpoint response shape. */
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

function isForeignApiBase(apiBase: string | undefined, ollamaHost: string): boolean {
  if (!apiBase) {
    return false;
  }

  try {
    return new URL(apiBase).host !== new URL(ollamaHost).host;
  } catch {
    // Unparseable but non-empty — the operator explicitly pointed us
    // somewhere, so honor it via the OpenAI client.
    return true;
  }
}

interface PromptOptions {
  model: string;
  signal?: AbortSignal;
  enableTools?: boolean;
  enableThinking?: boolean;
  format?: string;
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

@Injectable()
export class OllamaService {
  private readonly ollama = new Ollama({
    host: config.services.ollama.host,
  });

  /** Non-null iff the chat path should speak OpenAI protocol (foreign LLM_API_BASE). */
  private readonly openAiDriver = isForeignApiBase(config.llm.apiBase, config.services.ollama.host)
    ? new OpenAiCompatChatDriver(config.llm.apiBase as string, config.llm.apiKey)
    : null;

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly logger: LoggerService,
    private readonly featureService: FeatureService,
  ) {
    this.logger.setContext(OllamaService.name);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getAvailableModels(context: RequestContext): Promise<OllamaModel[]> {
    if (this.openAiDriver) {
      const modelIds = await this.openAiDriver.listModels();

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

    const stream = (async function* (self) {
      // The OpenAI protocol has no bare-prompt generate endpoint; a
      // single-user-message chat is the equivalent.
      if (self.openAiDriver) {
        const iterator = self.openAiDriver.chatStream({
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

    if (this.openAiDriver) {
      const response = await this.openAiDriver.chat({
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
    context: RequestContext,
    messages: OllamaMessage[],
    { model, signal, enableTools = false, enableThinking = true }: PromptOptions,
  ): Promise<AsyncGenerator<ChatResponse> & { messages: OllamaMessage[] }> {
    await this.validateModel(context, model);

    const inputMessages = messages.slice();
    const availableTools = enableTools ? this.toolRegistry.getAgentFacingTools(context) : [];
    const ollamaTools: Tool[] = availableTools.map(this.convertToOllamaTool);

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

        // Flush the chunk buffers at the start of every iteration.
        textChunks.splice(0, textChunks.length);
        thinkChunks.splice(0, thinkChunks.length);

        // Pop off any previously required tool calls and evaluate them.
        // Notably this will always be empty on the first iteration.
        const iterationToolCalls = toolCalls.splice(0, toolCalls.length);
        const toolEvaluations = await self.handleToolCalls(context, iterationToolCalls);

        // Tool evaluations may result in new accumulated messages.
        // We feed these forward into additional Ollama calls.
        accumulatedMessages.push(...toolEvaluations);

        // We only enable tools in this iteration if:
        //
        //   1. Tools are enabled for the service call
        //   2. Tools are configured / available in the system
        //   3. We did not evaluate any tools from the previous iteration
        //
        // This is important to get right.
        const iterationWillCallTools = enableTools && ollamaTools.length > 0 && toolEvaluations.length === 0;

        try {
          let iterator: AsyncIterable<ChatResponse>;

          if (self.openAiDriver) {
            // The driver observes the signal itself, so no abort hook is
            // needed; thinking arrives as reasoning deltas when the backend
            // emits them (no opt-in flag in the OpenAI protocol).
            iterator = self.openAiDriver.chatStream({
              model,
              messages: inputMessages.concat(accumulatedMessages),
              ...(iterationWillCallTools && { tools: ollamaTools }),
              signal,
            });
          } else {
            const nativeIterator = await self.ollama.chat({
              model,
              messages: inputMessages.concat(accumulatedMessages),
              stream: true,
              ...(enableThinking && { think: true }),
              ...(iterationWillCallTools && { tools: ollamaTools }),
            });

            handleAbort = () => nativeIterator.abort();

            signal?.addEventListener('abort', handleAbort);

            iterator = nativeIterator;
          }

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

          if (lastChunk?.done) {
            self.logger.log('Ollama prompt evaluation completed', {
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

            self.logger.error('Ollama prompt evaluation completed', {
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
            self.logger.log('Ollama prompt evaluation completed', {
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

  async chat(
    context: RequestContext,
    messages: OllamaMessage[],
    { model, enableTools = false, format }: Omit<PromptOptions, 'signal'>,
  ): Promise<ChatResponse> {
    await this.validateModel(context, model);

    const inputMessages = messages.slice();
    const availableTools = enableTools ? this.toolRegistry.getAgentFacingTools(context) : [];
    const ollamaTools: Tool[] = availableTools.map(this.convertToOllamaTool);

    const accumulatedMessages: OllamaMessage[] = [];

    const response = await this.chatOnce(model, inputMessages, {
      format,
      tools: enableTools && ollamaTools.length > 0 ? ollamaTools : undefined,
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

    return this.chatOnce(model, inputMessages.concat(accumulatedMessages), {});
  }

  /** One non-streaming chat completion through whichever transport is active. */
  private async chatOnce(
    model: string,
    messages: OllamaMessage[],
    options: { format?: string; tools?: Tool[] },
  ): Promise<ChatResponse> {
    if (this.openAiDriver) {
      return this.openAiDriver.chat({
        model,
        messages,
        tools: options.tools,
        format: options.format,
      });
    }

    return this.ollama.chat({
      model,
      messages,
      ...(options.format && { format: options.format }),
      ...(options.tools && options.tools.length > 0 && { tools: options.tools }),
    });
  }

  async resolveModel(context: RequestContext, opts?: ValidateModelOptions): Promise<ValidateModelResult> {
    const { messages = [], requestedModel, enableThinking = false, enableTools = false } = opts ?? {};

    let resolvedModel = requestedModel ?? PROMPT_MODEL;
    let resolvedThinking = enableThinking;
    let resolvedTools = enableTools;

    const pinnedDemoModelsEnabled = await this.featureService.isFeatureEnabled('pinned.demo.models');

    // If pinned demo models feature is enabled, always use demo models
    if (pinnedDemoModelsEnabled) {
      // Check if any message contains image content
      const hasVisualContent = messages.some((message) => message.images && message.images.length > 0);

      // Use vision model for images, text model for regular chat
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
    const [fullName, tag = 'latest'] = model.split(':'); // `namespace/model:tag`
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
   * Initialize tools registry with available tools
   */
  private async handleToolCalls(context: RequestContext, toolCalls: ToolCall[]): Promise<OllamaMessage[]> {
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

    // Execute each tool call
    const toolResults = await Promise.all(
      toolCalls.map(async (toolCall) => {
        const { name, arguments: args } = toolCall.function;

        try {
          const result = await this.toolRegistry.executeTool(name, context, args);

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

    // Build messages with tool results

    return toolResults.map(
      ({ result }) =>
        ({
          role: 'tool' as const,
          content: JSON.stringify(result),
        }) satisfies OllamaMessage,
    );
  }

  /**
   * Convert our ToolSchema to Ollama Tool format
   */
  private convertToOllamaTool(toolSchema: ToolSchema): Tool {
    return {
      type: 'function',
      function: {
        // schema.name is the dotted intent id; the LLM must call back with the executable
        // (underscored) name the ToolRegistry is keyed by.
        name: intentToolName(toolSchema.name),
        description: toolSchema.description,
        parameters: toolSchema.parameters,
      },
    };
  }

  private async validateModel(_context: RequestContext, requestedModel: string) {
    if (this.openAiDriver) {
      const modelIds = await this.openAiDriver.listModels();

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

    if (this.openAiDriver) {
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
