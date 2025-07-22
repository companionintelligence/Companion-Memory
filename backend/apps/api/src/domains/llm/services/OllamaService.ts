import { Injectable } from '@nestjs/common';
import ollama, { type ChatResponse, type GenerateResponse, type Message as OllamaMessage } from 'ollama';

import type { RequestContext } from '@ci/common/types';

import type { Message, OllamaModel } from '../types';

import { MessageService } from './MessageService';

const PROMPT_MODEL = 'gemma3:1b';
const INTERNAL_MODELS = new Set(['nomic-embed-text']);

interface PromptOptions {
  model?: string;
  signal?: AbortSignal;
}

type MessagesInput = Pick<Message, 'prompt' | 'text'>[];

@Injectable()
export class OllamaService {
  constructor(private readonly messageService: MessageService) {}

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
    const chunks: string[] = [];

    const stream = (async function* (self) {
      const resolvedOptions = options ?? {};
      const { model = PROMPT_MODEL, signal } = resolvedOptions;

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
          // TODO: Handle other properties on `chunk.message`.
          //   chunk.message.images?
          //   chunk.message.role
          //   chunk.message.tool_calls?
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
    const { model = PROMPT_MODEL } = resolvedOptions;

    return ollama.chat({
      model,
      messages: this.toOllamaMessages(messages),
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
}
