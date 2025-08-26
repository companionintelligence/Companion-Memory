import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  type ChatResponse,
  type GenerateResponse,
  type Message as OllamaMessage,
  type Tool,
  type ToolCall,
  Ollama,
} from 'ollama';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import config from '@ci/configuration';
import { MessageService } from '@ci/domains/conversations';

import {
  ToolRegistry,
  GetUserPreferencesTool,
  GetEntertainmentPreferencesTool,
  GetStreamingAvailabilityTool,
  type ToolSchema,
} from '../tools';
import type { OllamaModel } from '../types';

const PROMPT_MODEL = 'gemma3:1b';
const INTERNAL_MODELS = new Set(['nomic-embed-text']);

interface PromptOptions {
  model?: string;
  signal?: AbortSignal;
  enableTools?: boolean;
  enableThinking?: boolean;
}

@Injectable()
export class OllamaService {
  private readonly logger = new LoggerService(OllamaService.name);

  private readonly ollama = new Ollama({
    host: config.ollama.host,
  });

  private readonly toolRegistry = new ToolRegistry();

  constructor(
    private readonly messageService: MessageService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    this.initializeTools();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getAvailableModels(context: RequestContext): Promise<OllamaModel[]> {
    const result = await this.ollama.list();
    const models = result.models.map((model) => this.parseOllamaModel(model.name));

    return models.filter((model) => !INTERNAL_MODELS.has(model.name));
  }

  async generateStream(
    context: RequestContext,
    prompt: string,
    options?: PromptOptions,
  ): Promise<AsyncGenerator<GenerateResponse> & { buffer: string }> {
    const chunks: string[] = [];

    const stream = (async function* (self) {
      const resolvedOptions = options ?? {};
      const { model = PROMPT_MODEL, signal } = resolvedOptions;

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
    options?: Omit<PromptOptions, 'signal'>,
  ): Promise<GenerateResponse> {
    const resolvedOptions = options ?? ({} as PromptOptions);
    const { model = PROMPT_MODEL } = resolvedOptions;

    return this.ollama.generate({
      model,
      prompt,
    });
  }

  async chatStream(
    context: RequestContext,
    messages: OllamaMessage[],
    options?: PromptOptions,
  ): Promise<AsyncGenerator<ChatResponse> & { messages: OllamaMessage[] }> {
    const resolvedOptions = options ?? {};
    const { model = PROMPT_MODEL, signal, enableTools = false, enableThinking = true } = resolvedOptions;

    const inputMessages = messages.slice();
    const availableTools = enableTools ? this.toolRegistry.getAvailableTools(context) : [];
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
            self.logger.error('Ollama prompt evaluation completed', {
              model: lastChunk?.model ?? resolvedOptions.model,
              doneReason: 'error',
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
              model: lastChunk?.model ?? resolvedOptions.model,
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
    options?: Omit<PromptOptions, 'signal'>,
  ): Promise<ChatResponse> {
    const resolvedOptions = options ?? ({} as PromptOptions);
    const { model = PROMPT_MODEL, enableTools = false } = resolvedOptions;

    const inputMessages = messages.slice();
    const availableTools = enableTools ? this.toolRegistry.getAvailableTools(context) : [];
    const ollamaTools: Tool[] = availableTools.map(this.convertToOllamaTool);

    const accumulatedMessages: OllamaMessage[] = [];

    const response = await this.ollama.chat({
      model,
      messages: inputMessages,
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

    return this.ollama.chat({
      model,
      messages: inputMessages.concat(accumulatedMessages),
    });
  }

  async validateModel(context: RequestContext, model: string | undefined): Promise<OllamaModel> {
    const resolvedModel = model ?? PROMPT_MODEL;

    const availableModels = await this.getAvailableModels(context);

    const validModel = availableModels.find((availableModel) => availableModel.model === resolvedModel);

    if (!validModel) {
      throw new Error(`Invalid model specified: ${model}`);
    }

    return validModel;
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
  private initializeTools(): void {
    const getUserPreferencesTool = new GetUserPreferencesTool(this.dataSource);
    const getEntertainmentPreferencesTool = new GetEntertainmentPreferencesTool(this.dataSource);
    const getStreamingAvailabilityTool = new GetStreamingAvailabilityTool();
    // const getFamilyMembersTool = new GetFamilyMembersTool(this.dataSource); // Disabled for demo

    this.toolRegistry.register(getUserPreferencesTool);
    this.toolRegistry.register(getEntertainmentPreferencesTool);
    this.toolRegistry.register(getStreamingAvailabilityTool);
    // this.toolRegistry.register(getFamilyMembersTool); // Disabled for demo

    this.logger.debug('Initialized tools registry', {
      toolCount: this.toolRegistry.getRegisteredToolNames().length,
      tools: this.toolRegistry.getRegisteredToolNames(),
    });
  }

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
        name: toolSchema.name,
        description: toolSchema.description,
        parameters: toolSchema.parameters,
      },
    };
  }
}
