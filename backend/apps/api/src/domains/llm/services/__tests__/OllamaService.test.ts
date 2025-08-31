import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Ollama, type ChatResponse } from 'ollama';

import type { RequestContext } from '@ci/common/types';
import { MessageService } from '@ci/domains/conversations';

import { OllamaService } from '../OllamaService';

// Mock the Ollama class
jest.mock('ollama');
const MockedOllama = Ollama as jest.MockedClass<typeof Ollama>;

describe('OllamaService', () => {
  let service: OllamaService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockOllamaInstance: any;

  const mockContext: RequestContext = {
    userId: 'test-user-id',
  };

  beforeEach(async () => {
    mockOllamaInstance = {
      chat: jest.fn(),
      list: jest.fn().mockResolvedValue({ models: [] }),
      generate: jest.fn(),
    };

    MockedOllama.mockImplementation(() => mockOllamaInstance);

    const module = await Test.createTestingModule({
      providers: [
        OllamaService,
        {
          provide: MessageService,
          useValue: {
            create: jest.fn(),
            findByThread: jest.fn(),
          },
        },
        {
          provide: getDataSourceToken(),
          useValue: {
            manager: {},
          },
        },
      ],
    }).compile();

    service = module.get<OllamaService>(OllamaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('chat method with tool support errors', () => {
    it('should retry without tools when model does not support tools', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages = [{ role: 'user', content: 'Hello' }] as any[];

      // First call with tools fails
      const toolError = new Error('tools are not supported by this model');
      mockOllamaInstance.chat.mockRejectedValueOnce(toolError).mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Hello there!' },
        model: 'test-model',
        created_at: new Date(),
        done: true,
      } as unknown as ChatResponse);

      const result = await service.chat(mockContext, messages, { enableTools: true });

      // Should have been called twice - once with tools (failed), once without tools (succeeded)
      expect(mockOllamaInstance.chat).toHaveBeenCalledTimes(2);

      // First call should include tools
      expect(mockOllamaInstance.chat).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          tools: expect.any(Array),
        }),
      );

      // Second call should not include tools
      expect(mockOllamaInstance.chat).toHaveBeenNthCalledWith(
        2,
        expect.not.objectContaining({
          tools: expect.anything(),
        }),
      );

      expect(result.message.content).toBe('Hello there!');
    });

    it('should not retry when error is not tool-related', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages = [{ role: 'user', content: 'Hello' }] as any[];

      const networkError = new Error('Network connection failed');
      mockOllamaInstance.chat.mockRejectedValue(networkError);

      await expect(service.chat(mockContext, messages, { enableTools: true })).rejects.toThrow(
        'Network connection failed',
      );

      // Should only be called once, no retry
      expect(mockOllamaInstance.chat).toHaveBeenCalledTimes(1);
    });

    it('should work normally when tools are not enabled', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages = [{ role: 'user', content: 'Hello' }] as any[];

      mockOllamaInstance.chat.mockResolvedValue({
        message: { role: 'assistant', content: 'Hello there!' },
        model: 'test-model',
        created_at: new Date(),
        done: true,
      } as unknown as ChatResponse);

      const result = await service.chat(mockContext, messages, { enableTools: false });

      expect(mockOllamaInstance.chat).toHaveBeenCalledTimes(1);
      expect(mockOllamaInstance.chat).toHaveBeenCalledWith(
        expect.not.objectContaining({
          tools: expect.anything(),
        }),
      );
      expect(result.message.content).toBe('Hello there!');
    });
  });

  describe('chatStream method with tool support errors', () => {
    it('should retry without tools when model does not support tools in streaming', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages = [{ role: 'user', content: 'Hello' }] as any[];

      // First call with tools fails
      const toolError = new Error('tools are not supported by this model');

      // Create mock iterator for successful call
      const mockIterator = {
        [Symbol.asyncIterator]: jest.fn().mockImplementation(async function* () {
          yield {
            message: { role: 'assistant', content: 'Hello' },
            model: 'test-model',
            created_at: new Date(),
            done: false,
          } as unknown as ChatResponse;
          yield {
            message: { role: 'assistant', content: ' there!' },
            model: 'test-model',
            created_at: new Date(),
            done: true,
            total_duration: 1000000,
          } as unknown as ChatResponse;
        }),
        abort: jest.fn(),
      };

      mockOllamaInstance.chat.mockRejectedValueOnce(toolError).mockResolvedValueOnce(mockIterator);

      const result = await service.chatStream(mockContext, messages, { enableTools: true });

      // Consume the stream
      const chunks = [];
      for await (const chunk of result) {
        chunks.push(chunk);
      }

      // Should have been called twice - once with tools (failed), once without tools (succeeded)
      expect(mockOllamaInstance.chat).toHaveBeenCalledTimes(2);

      // First call should include tools
      expect(mockOllamaInstance.chat).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          tools: expect.any(Array),
        }),
      );

      // Second call should not include tools
      expect(mockOllamaInstance.chat).toHaveBeenNthCalledWith(
        2,
        expect.not.objectContaining({
          tools: expect.anything(),
        }),
      );

      expect(chunks).toHaveLength(2);
    });
  });
});
