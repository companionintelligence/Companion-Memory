import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import ollama, { type ChatResponse, type GenerateResponse, type Message as OllamaMessage, type Tool } from 'ollama';

import type { RequestContext } from '@ci/common/types';
import { LoggerService } from '@ci/common/services';

import type { Message, OllamaModel } from '../types';
import { ToolRegistry, GetUserPreferencesTool, GetFamilyMembersTool, GetEntertainmentPreferencesTool, GetStreamingAvailabilityTool, type ToolSchema } from '../tools';

import { MessageService } from './MessageService';

const PROMPT_MODEL = 'gemma3:1b';
const INTERNAL_MODELS = new Set(['nomic-embed-text']);

interface PromptOptions {
  model?: string;
  signal?: AbortSignal;
  enableTools?: boolean;
}

type MessagesInput = Pick<Message, 'prompt' | 'text'>[];

@Injectable()
export class OllamaService {
  private readonly logger = new LoggerService(OllamaService.name);
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
    const result = await ollama.list();
    const models = result.models.map((model) => this.parseOllamaModel(model.name));

    return models.filter((model) => !INTERNAL_MODELS.has(model.name));
  }

  async generateStream(
    context: RequestContext,
    prompt: string,
    options?: PromptOptions,
  ): Promise<AsyncGenerator<GenerateResponse> & { buffer: string }> {
    const chunks: string[] = [];

    const stream = (async function* () {
      const resolvedOptions = options ?? {};
      const { model = PROMPT_MODEL, signal } = resolvedOptions;

      const iterator = await ollama.generate({
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
    })();

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

    return ollama.generate({
      model,
      prompt,
    });
  }

  async chatStream(
    context: RequestContext,
    messages: MessagesInput,
    options?: PromptOptions,
  ): Promise<AsyncGenerator<ChatResponse> & { buffer: string }> {
    const resolvedOptions = options ?? {};
    const { model = PROMPT_MODEL, signal, enableTools = false } = resolvedOptions;

    // If tools are enabled, handle function calling before streaming
    if (enableTools) {
      return this.chatStreamWithTools(context, messages, options);
    }

    // Original streaming implementation
    const chunks: string[] = [];

    const stream = (async function* (self) {
      const iterator = await ollama.chat({
        model,
        messages: self.toOllamaMessages(messages),
        stream: true,
      });

      signal?.addEventListener('abort', () => {
        iterator.abort();
      });

      for await (const chunk of iterator) {
        if (chunk && !!chunk.message) {
          chunks.push(chunk.message.content);
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

  async chat(
    context: RequestContext,
    messages: MessagesInput,
    options?: Omit<PromptOptions, 'signal'>,
  ): Promise<ChatResponse> {
    const resolvedOptions = options ?? ({} as PromptOptions);
    const { model = PROMPT_MODEL, enableTools = false } = resolvedOptions;

    // If tools are enabled, use function calling
    if (enableTools) {
      return this.chatWithTools(context, messages, options);
    }

    return ollama.chat({
      model,
      messages: this.toOllamaMessages(messages),
    });
  }

  /**
   * Chat with function calling support
   */
  async chatWithTools(
    context: RequestContext,
    messages: MessagesInput,
    options?: Omit<PromptOptions, 'signal'>,
  ): Promise<ChatResponse> {
    const resolvedOptions = options ?? ({} as PromptOptions);
    const { model = PROMPT_MODEL } = resolvedOptions;

    // Get available tools
    const availableTools = this.toolRegistry.getAvailableTools(context);
    const ollamaTools: Tool[] = availableTools.map(this.convertToOllamaTool);

    const requestPayload = {
      model,
      messages: this.toOllamaMessages(messages),
      ...(ollamaTools.length > 0 && { tools: ollamaTools }),
    };

    this.logger.debug('Sending chat request with tools', {
      model,
      messageCount: messages.length,
      toolCount: ollamaTools.length,
      toolNames: availableTools.map(t => t.name),
      userId: context.userId,
    });

    const response = await ollama.chat(requestPayload);

    // Handle tool calls if present
    if (response.message.tool_calls && response.message.tool_calls.length > 0) {
      return await this.handleToolCalls(context, messages, response, options);
    }

    return response;
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

  private toOllamaMessages(messages: MessagesInput): OllamaMessage[] {
    const ollamaMessages: OllamaMessage[] = messages.map(
      (message) =>
        ({
          role: message.prompt ? 'user' : 'system',
          content: message.text ?? '',
        }) satisfies OllamaMessage,
    );

    return ollamaMessages;
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

  /**
   * Process tool calls and return final response
   */
  private async handleToolCalls(
    context: RequestContext,
    originalMessages: MessagesInput,
    toolCallResponse: ChatResponse,
    options?: Omit<PromptOptions, 'signal'>,
  ): Promise<ChatResponse> {
    const { model = PROMPT_MODEL } = options ?? {};
    const toolCalls = toolCallResponse.message.tool_calls || [];

    this.logger.debug('Processing tool calls', {
      toolCallCount: toolCalls.length,
      toolNames: toolCalls.map(tc => tc.function.name),
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
      })
    );

    // Build messages with tool results
    const messagesWithToolResults = [
      ...this.toOllamaMessages(originalMessages),
      {
        role: 'assistant' as const,
        content: toolCallResponse.message.content,
        tool_calls: toolCalls,
      },
      ...toolResults.map(({ call, result }) => ({
        role: 'tool' as const,
        content: JSON.stringify(result),
        tool_call_id: call.function.name,
      })),
    ];

    // Get final response incorporating tool results
    const finalResponse = await ollama.chat({
      model,
      messages: messagesWithToolResults,
    });

    this.logger.debug('Completed tool-assisted conversation', {
      toolResultsCount: toolResults.length,
      successfulTools: toolResults.filter(r => r.success).length,
      userId: context.userId,
    });

    return finalResponse;
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

  /**
   * Streaming chat with function calling support
   * Strategy: Check for tool calls first, execute them, then stream the final response
   */
  private async chatStreamWithTools(
    context: RequestContext,
    messages: MessagesInput,
    options?: PromptOptions,
  ): Promise<AsyncGenerator<ChatResponse> & { buffer: string }> {
    const resolvedOptions = options ?? {};
    const { model = PROMPT_MODEL, signal } = resolvedOptions;

    // Step 1: Get available tools and make initial non-streaming call to check for tool calls
    const availableTools = this.toolRegistry.getAvailableTools(context);
    const ollamaTools: Tool[] = availableTools.map(this.convertToOllamaTool);

    try {
      const initialResponse = await ollama.chat({
        model,
        messages: this.toOllamaMessages(messages),
        ...(ollamaTools.length > 0 && { tools: ollamaTools }),
      });

      // Step 2: If there are tool calls, execute them and prepare for final streaming response
      if (initialResponse.message.tool_calls && initialResponse.message.tool_calls.length > 0) {
        return this.handleToolCallsAndStream(context, messages, initialResponse, options);
      }

      // No tool calls needed, proceed with regular streaming
      return this.regularStream(context, messages, options);

    } catch (error) {
      // Handle case where model doesn't support tools
      if (error instanceof Error && error.message.includes('does not support tools')) {
        this.logger.warn('Model does not support tools, falling back to regular chat', {
          model,
          userId: context.userId,
        });
        return this.regularStream(context, messages, options);
      }
      
      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Handle tool calls and stream the final response
   */
  private async handleToolCallsAndStream(
    context: RequestContext,
    originalMessages: MessagesInput,
    toolCallResponse: ChatResponse,
    options?: PromptOptions,
  ): Promise<AsyncGenerator<ChatResponse> & { buffer: string }> {
    const resolvedOptions = options ?? {};
    const { model = PROMPT_MODEL, signal } = resolvedOptions;
    const toolCalls = toolCallResponse.message.tool_calls || [];
    
    this.logger.debug('Processing tool calls in stream', {
      toolCallCount: toolCalls.length,
      toolNames: toolCalls.map(tc => tc.function.name),
      userId: context.userId,
    });

    // Execute tool calls
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
          this.logger.error('Tool execution failed in stream', {
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
      })
    );

    // Build messages with tool results
    const messagesWithToolResults = [
      ...this.toOllamaMessages(originalMessages),
      {
        role: 'assistant' as const,
        content: toolCallResponse.message.content,
        tool_calls: toolCalls,
      },
      ...toolResults.map(({ call, result }) => ({
        role: 'tool' as const,
        content: JSON.stringify(result),
        tool_call_id: call.function.name,
      })),
    ];

    // Stream the final response with tool context
    const chunks: string[] = [];

    const stream = (async function* (self) {
      const iterator = await ollama.chat({
        model,
        messages: messagesWithToolResults,
        stream: true,
      });

      signal?.addEventListener('abort', () => {
        iterator.abort();
      });

      for await (const chunk of iterator) {
        if (chunk && !!chunk.message) {
          chunks.push(chunk.message.content);
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

  /**
   * Regular streaming without tools
   */
  private async regularStream(
    context: RequestContext,
    messages: MessagesInput,
    options?: PromptOptions,
  ): Promise<AsyncGenerator<ChatResponse> & { buffer: string }> {
    const resolvedOptions = options ?? {};
    const { model = PROMPT_MODEL, signal } = resolvedOptions;
    
    const chunks: string[] = [];

    const stream = (async function* (self) {
      const iterator = await ollama.chat({
        model,
        messages: self.toOllamaMessages(messages),
        stream: true,
      });

      signal?.addEventListener('abort', () => {
        iterator.abort();
      });

      for await (const chunk of iterator) {
        if (chunk && !!chunk.message) {
          chunks.push(chunk.message.content);
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
}
