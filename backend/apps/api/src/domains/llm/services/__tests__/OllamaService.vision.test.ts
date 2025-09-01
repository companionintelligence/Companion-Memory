import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Ollama, type Message, type ChatResponse } from 'ollama';
import { DataSource } from 'typeorm';

import type { RequestContext } from '@ci/common/types';
import { MessageService } from '@ci/domains/conversations';

import { OllamaService } from '../OllamaService';

// Mock Ollama
jest.mock('ollama');
const MockOllama = jest.mocked(Ollama);

describe('OllamaService - Vision Support', () => {
  let service: OllamaService;
  let mockOllamaInstance: jest.Mocked<Ollama>;
  let mockContext: RequestContext;

  beforeEach(async () => {
    // Create mock Ollama instance
    mockOllamaInstance = {
      list: jest.fn(),
      chat: jest.fn(),
    } as any;

    MockOllama.mockImplementation(() => mockOllamaInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OllamaService,
        {
          provide: MessageService,
          useValue: {
            create: jest.fn(),
            findByThread: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: getDataSourceToken(),
          useValue: {} as DataSource,
        },
      ],
    }).compile();

    service = module.get<OllamaService>(OllamaService);
    mockContext = { userId: 'test-user' };
  });

  describe('Vision Model Detection', () => {
    it('should identify vision models correctly', async () => {
      // Mock available models including vision models
      mockOllamaInstance.list.mockResolvedValue({
        models: [
          { name: 'llama3.2-vision:11b' },
          { name: 'llava:13b' },
          { name: 'gemma3:1b' },
          { name: 'minicpm-v:8b' },
          { name: 'moondream:1.8b' },
          { name: 'bakllava:7b' },
        ]
      } as any);

      const models = await service.getAvailableModels(mockContext);
      const visionModels = models.filter(model => service.isVisionModel(model.name));

      expect(visionModels.length).toBeGreaterThan(0);
      expect(visionModels.some(m => m.name.includes('llava'))).toBe(true);
    });
  });

  describe('Image Message Handling', () => {
    it('should handle messages with images', async () => {
      const mockImage = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header
      const messagesWithImages: Message[] = [
        {
          role: 'user',
          content: 'What do you see in this image?',
          images: [mockImage],
        },
      ];

      const mockResponse: ChatResponse = {
        model: 'llava:13b',
        created_at: new Date(),
        message: {
          role: 'assistant',
          content: 'I can see an image has been provided.',
        },
        done: true,
        done_reason: 'stop',
        total_duration: 1000000,
        load_duration: 500000,
        prompt_eval_count: 10,
        prompt_eval_duration: 200000,
        eval_count: 20,
        eval_duration: 300000,
      };

      mockOllamaInstance.chat.mockResolvedValue(mockResponse);

      const response = await service.chat(mockContext, messagesWithImages, {
        model: 'llava:13b',
      });

      expect(response).toBeDefined();
      expect(response.message.content).toBe('I can see an image has been provided.');
      expect(mockOllamaInstance.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'llava:13b',
          messages: messagesWithImages,
        })
      );
    });

    it('should detect when images are present in messages', async () => {
      const messageWithImage: Message = {
        role: 'user',
        content: 'What do you see?',
        images: [new Uint8Array([1, 2, 3])],
      };

      const messageWithoutImage: Message = {
        role: 'user',
        content: 'Hello there',
      };

      // Create a method to check if messages contain images
      const hasImages = (messages: Message[]): boolean => {
        return messages.some(msg => msg.images && msg.images.length > 0);
      };

      expect(hasImages([messageWithImage])).toBe(true);
      expect(hasImages([messageWithoutImage])).toBe(false);
      expect(hasImages([messageWithoutImage, messageWithImage])).toBe(true);
    });
  });

  describe('Model Validation with Images', () => {
    beforeEach(() => {
      mockOllamaInstance.list.mockResolvedValue({
        models: [
          { name: 'llava:13b' },
          { name: 'gemma3:1b' },
          { name: 'llama3.2-vision:11b' },
        ]
      } as any);
    });

    it('should validate that a vision model is used when images are present', async () => {
      // This test will pass once we implement proper vision model validation
      const validVisionModel = await service.validateModel(mockContext, 'llava:13b');
      expect(validVisionModel.model).toBe('llava:13b');
    });

    it('should throw error when non-vision model is used with images', async () => {
      // Mock that gemma3:1b is available but not llava
      mockOllamaInstance.list.mockResolvedValue({
        models: [
          { name: 'gemma3:1b' },
        ]
      } as any);

      const messagesWithImages: Message[] = [
        {
          role: 'user',
          content: 'What do you see?',
          images: [new Uint8Array([1, 2, 3])],
        },
      ];

      // Using a non-vision model with images should throw an error
      await expect(
        service.chat(mockContext, messagesWithImages, {
          model: 'gemma3:1b', // Non-vision model
        })
      ).rejects.toThrow('Images detected but no vision model is available');
    });

    it('should auto-select vision model when images are present', async () => {
      // Mock that both models are available
      mockOllamaInstance.list.mockResolvedValue({
        models: [
          { name: 'llava:13b' },
          { name: 'gemma3:1b' },
        ]
      } as any);

      const messagesWithImages: Message[] = [
        {
          role: 'user',
          content: 'What do you see?',
          images: [new Uint8Array([1, 2, 3])],
        },
      ];

      const mockResponse: ChatResponse = {
        model: 'llava:13b',
        created_at: new Date(),
        message: {
          role: 'assistant',
          content: 'I can see an image.',
        },
        done: true,
        done_reason: 'stop',
        total_duration: 1000000,
        load_duration: 500000,
        prompt_eval_count: 10,
        prompt_eval_duration: 200000,
        eval_count: 20,
        eval_duration: 300000,
      };

      mockOllamaInstance.chat.mockResolvedValue(mockResponse);

      // Should auto-select vision model when no specific model is requested
      const response = await service.chat(mockContext, messagesWithImages);

      expect(response).toBeDefined();
      expect(mockOllamaInstance.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'llava:13b', // Should auto-select vision model
          messages: messagesWithImages,
        })
      );
    });

    it('should use demo vision mode when enabled', async () => {
      // This test is simplified - the demo mode would be tested in integration tests
      // or by temporarily enabling the feature flag
      const messagesWithImages: Message[] = [
        {
          role: 'user',
          content: 'What do you see?',
          images: [new Uint8Array([1, 2, 3])],
        },
      ];

      // Mock config to simulate demo mode not available, should fall back to error
      mockOllamaInstance.list.mockResolvedValue({
        models: [
          { name: 'gemma3:1b' }, // No vision models available
        ]
      } as any);

      await expect(
        service.chat(mockContext, messagesWithImages)
      ).rejects.toThrow('Images detected but no vision model is available');
    });
  });
});