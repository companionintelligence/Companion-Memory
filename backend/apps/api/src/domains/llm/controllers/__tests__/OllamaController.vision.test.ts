import { Test, TestingModule } from '@nestjs/testing';
import { Response } from 'express';

import type { RequestContext } from '@ci/common/types';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { EventService } from '@ci/domains/events';
import { FileService, type File } from '@ci/domains/files';

import { OllamaController } from '../OllamaController';
import { OllamaService } from '../../services/OllamaService';

describe('OllamaController - Vision Integration', () => {
  let controller: OllamaController;
  let mockOllamaService: jest.Mocked<OllamaService>;
  let mockFileService: jest.Mocked<FileService>;
  let mockContext: RequestContext;

  beforeEach(async () => {
    // Create mocks
    mockOllamaService = {
      validateModel: jest.fn(),
      chatStream: jest.fn(),
    } as any;

    mockFileService = {
      findByThread: jest.fn(),
      getFileContent: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OllamaController],
      providers: [
        {
          provide: EventService,
          useValue: {
            send: jest.fn(),
          },
        },
        {
          provide: MessageService,
          useValue: {
            create: jest.fn().mockResolvedValue({ id: 'mock-message-id' }),
            findByThread: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: OllamaService,
          useValue: mockOllamaService,
        },
        {
          provide: ThreadService,
          useValue: {
            exists: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: FileService,
          useValue: mockFileService,
        },
      ],
    }).compile();

    controller = module.get<OllamaController>(OllamaController);
    mockContext = { userId: 'test-user' };
  });

  describe('Image File Processing', () => {
    it('should filter and process image files correctly', async () => {
      // Mock files - mix of images and non-images
      const mockFiles: File[] = [
        {
          id: 'file1',
          name: 'image1.jpg',
          key: 'key1',
          contentType: 'image/jpeg',
          size: 1000,
        },
        {
          id: 'file2', 
          name: 'document.pdf',
          key: 'key2',
          contentType: 'application/pdf',
          size: 2000,
        },
        {
          id: 'file3',
          name: 'image2.png',
          key: 'key3', 
          contentType: 'image/png',
          size: 1500,
        },
      ];

      // Mock image data
      const imageData1 = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header
      const imageData2 = new Uint8Array([255, 216, 255, 224]); // JPEG header

      mockFileService.findByThread.mockResolvedValue(mockFiles);
      mockFileService.getFileContent.mockImplementation(async (context, key) => {
        if (key === 'key1') return imageData1;
        if (key === 'key3') return imageData2;
        throw new Error('Should not be called for non-image files');
      });

      mockOllamaService.validateModel.mockResolvedValue({
        model: 'llava:13b',
        namespace: null,
        name: 'llava',
        tag: '13b',
      });

      // Mock stream response
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            message: {
              content: 'I can see two images provided.',
            },
          };
        },
        messages: [{
          role: 'assistant',
          content: 'I can see two images provided.',
        }],
      };

      mockOllamaService.chatStream.mockResolvedValue(mockStream as any);

      // Mock response object
      const mockResponse = {
        socket: { setNoDelay: jest.fn() },
        writeHead: jest.fn(),
        flushHeaders: jest.fn(),
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      } as any;

      const input = {
        prompt: 'What do you see in these images?',
        threadId: 'test-thread',
        enableTools: true,
        enableThinking: true,
      };

      await controller.generate(mockContext, input, mockResponse);

      // Verify that only image files were processed
      expect(mockFileService.getFileContent).toHaveBeenCalledTimes(2);
      expect(mockFileService.getFileContent).toHaveBeenCalledWith(mockContext, 'key1');
      expect(mockFileService.getFileContent).toHaveBeenCalledWith(mockContext, 'key3');
      expect(mockFileService.getFileContent).not.toHaveBeenCalledWith(mockContext, 'key2');

      // Verify that chatStream was called with images
      expect(mockOllamaService.chatStream).toHaveBeenCalledWith(
        mockContext,
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: '',
            images: [imageData1, imageData2],
          }),
        ]),
        expect.any(Object)
      );
    });

    it('should handle threads with no images correctly', async () => {
      // Mock files with no images
      const mockFiles: File[] = [
        {
          id: 'file1',
          name: 'document.pdf',
          key: 'key1',
          contentType: 'application/pdf', 
          size: 1000,
        },
      ];

      mockFileService.findByThread.mockResolvedValue(mockFiles);

      mockOllamaService.validateModel.mockResolvedValue({
        model: 'gemma3:1b',
        namespace: null,
        name: 'gemma3',
        tag: '1b',
      });

      // Mock stream response
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            message: {
              content: 'Hello! No images detected.',
            },
          };
        },
        messages: [{
          role: 'assistant',
          content: 'Hello! No images detected.',
        }],
      };

      mockOllamaService.chatStream.mockResolvedValue(mockStream as any);

      const mockResponse = {
        socket: { setNoDelay: jest.fn() },
        writeHead: jest.fn(),
        flushHeaders: jest.fn(),
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      } as any;

      const input = {
        prompt: 'Hello there',
        threadId: 'test-thread',
        enableTools: true,
        enableThinking: true,
      };

      await controller.generate(mockContext, input, mockResponse);

      // Verify that no images were loaded
      expect(mockFileService.getFileContent).not.toHaveBeenCalled();

      // Verify that chatStream was called without images in the message
      expect(mockOllamaService.chatStream).toHaveBeenCalledWith(
        mockContext,
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: '',
            // images property should not be present
          }),
        ]),
        expect.any(Object)
      );

      const firstMessage = mockOllamaService.chatStream.mock.calls[0][1][0];
      expect(firstMessage).not.toHaveProperty('images');
    });
  });
});