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
const DEFAULT_VISION_MODEL = 'llava:13b';
const INTERNAL_MODELS = new Set(['nomic-embed-text']);

// Known vision models patterns
const VISION_MODEL_PATTERNS = [
  'llava',
  'vision', 
  'minicpm-v',
  'minicpm',
  'moondream',
  'bakllava',
  'cogvlm',
  'qwen-vl',
  'llama3.2-vision'
];

// Demo vision responses for fallback mode
const DEMO_VISION_RESPONSES = [
  "I can see what appears to be a photo that was just taken. The image shows various objects and details that I can analyze for you.",
  "This looks like a freshly captured image. I can observe several interesting elements and details in the scene.",
  "I'm looking at what seems to be a photograph that was recently taken. There are various visual elements I can describe.",
  "I can see this is an image that appears to have been captured with a camera. Let me analyze what's visible in the scene.",
  "This looks like a photo that was just taken. I can observe different objects, colors, and details in the image.",
];

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
    host: config.services.ollama.host,
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
    const { signal, enableTools = false, enableThinking = true } = resolvedOptions;

    // Select appropriate model based on whether images are present
    const selectedModel = await this.selectModelForMessages(context, resolvedOptions.model, messages);

    // Handle demo vision mode
    if (selectedModel === 'demo-vision') {
      // Consume the demo stream once, cache chunks and build messages array
      const cachedChunks: ChatResponse[] = [];
      const messageContent: string[] = [];
      for await (const chunk of this.generateDemoVisionResponseStream(messages)) {
        cachedChunks.push(chunk);
        if (chunk.message.content) {
          messageContent.push(chunk.message.content);
        }
      }

      const accumulatedMessages: OllamaMessage[] = [{
        role: 'assistant',
        content: messageContent.join(''),
      }];

      // Create a replayable async generator from cached chunks
      async function* replayStream() {
        for (const chunk of cachedChunks) {
          yield chunk;
        }
      }

      Object.defineProperty(replayStream, 'messages', {
        enumerable: true,
        get: () => accumulatedMessages,
      });

      return replayStream as typeof replayStream & { messages: OllamaMessage[] };
    }

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
            model: selectedModel,
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
              model: lastChunk?.model ?? selectedModel,
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
              model: lastChunk?.model ?? selectedModel,
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
    const { enableTools = false } = resolvedOptions;

    // Select appropriate model based on whether images are present  
    const selectedModel = await this.selectModelForMessages(context, resolvedOptions.model, messages);

    // Handle demo vision mode
    if (selectedModel === 'demo-vision') {
      return this.generateDemoVisionResponse(messages);
    }

    const inputMessages = messages.slice();
    const availableTools = enableTools ? this.toolRegistry.getAvailableTools(context) : [];
    const ollamaTools: Tool[] = availableTools.map(this.convertToOllamaTool);

    const accumulatedMessages: OllamaMessage[] = [];

    const response = await this.ollama.chat({
      model: selectedModel,
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
      model: selectedModel,
      messages: inputMessages.concat(accumulatedMessages),
    });
  }

  /**
   * Check if a model supports vision based on its name
   */
  private isVisionModel(modelName: string): boolean {
    const lowerName = modelName.toLowerCase();
    return VISION_MODEL_PATTERNS.some(pattern => lowerName.includes(pattern));
  }

  /**
   * Check if messages contain images
   */
  private hasImages(messages: OllamaMessage[]): boolean {
    return messages.some(msg => msg.images && msg.images.length > 0);
  }

  /**
   * Get the first available vision model from the available models
   */
  private async getDefaultVisionModel(context: RequestContext): Promise<OllamaModel | null> {
    const availableModels = await this.getAvailableModels(context);
    const visionModel = availableModels.find(model => this.isVisionModel(model.model));
    return visionModel || null;
  }

  /**
   * Generate a demo vision response when in demo mode
   */
  private generateDemoVisionResponse(messages: OllamaMessage[]): ChatResponse {
    const randomResponse = DEMO_VISION_RESPONSES[Math.floor(Math.random() * DEMO_VISION_RESPONSES.length)];
    
    return {
      model: 'demo-vision',
      created_at: new Date(),
      message: {
        role: 'assistant',
        content: randomResponse,
      },
      done: true,
      done_reason: 'stop',
      total_duration: 1000000,
      load_duration: 100000,
      prompt_eval_count: 10,
      prompt_eval_duration: 200000,
      eval_count: 15,
      eval_duration: 700000,
    };
  }

  /**
   * Generate a demo vision response stream when in demo mode
   */
  private async *generateDemoVisionResponseStream(messages: OllamaMessage[]): AsyncGenerator<ChatResponse> {
    const response = this.generateDemoVisionResponse(messages);
    const content = response.message.content;
    
    // Split content into chunks to simulate streaming
    const words = content.split(' ');
    const chunkSize = Math.max(1, Math.floor(words.length / 4));
    
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize).join(' ');
      const isLast = i + chunkSize >= words.length;
      
      yield {
        model: 'demo-vision',
        created_at: new Date(),
        message: {
          role: 'assistant',
          content: chunk + (isLast ? '' : ' '),
        },
        done: isLast,
        done_reason: isLast ? 'stop' : '',
        total_duration: isLast ? 1000000 : 0,
        load_duration: isLast ? 100000 : 0,
        prompt_eval_count: isLast ? 10 : 0,
        prompt_eval_duration: isLast ? 200000 : 0,
        eval_count: isLast ? 15 : 0,
        eval_duration: isLast ? 700000 : 0,
      };
      
      // Add slight delay to make it feel more realistic
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Select appropriate model based on whether images are present
   */
  private async selectModelForMessages(
    context: RequestContext,
    requestedModel: string | undefined,
    messages: OllamaMessage[]
  ): Promise<string> {
    const hasImagesInMessages = this.hasImages(messages);
    
    if (hasImagesInMessages) {
      // Check if demo mode is enabled
      if (config.features['vision.demo.mode']) {
        this.logger.warn('Vision demo mode is enabled - using demo responses for image input');
        return 'demo-vision';
      }
      
      // If images are present, ensure we use a vision model
      if (requestedModel && this.isVisionModel(requestedModel)) {
        return requestedModel;
      }
      
      // Try to find a default vision model
      const defaultVisionModel = await this.getDefaultVisionModel(context);
      if (defaultVisionModel) {
        this.logger.warn(`Auto-selecting vision model for image input`, {
          requestedModel,
          selectedModel: defaultVisionModel.model,
        });
        return defaultVisionModel.model;
      }
      
      // Fallback to a known vision model if available
      const availableModels = await this.getAvailableModels(context);
      if (availableModels.some(m => m.model === DEFAULT_VISION_MODEL)) {
        this.logger.warn(`Using fallback vision model for image input`, {
          requestedModel,
          selectedModel: DEFAULT_VISION_MODEL,
        });
        return DEFAULT_VISION_MODEL;
      }
      
      throw new Error(
        'Images detected but no vision model is available. Please install a vision model like llava:13b or enable vision.demo.mode'
      );
    }
    
    // No images present, use requested model or default
    return requestedModel || PROMPT_MODEL;
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
