import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/services';

import { FileEntity } from '../entities/FileEntity';
import { FileService } from '../services/FileService';
import { FileParsingService } from '../services/FileParsingService';

describe('FileParsingService', () => {
  let service: FileParsingService;
  let fileRepository: jest.Mocked<Repository<FileEntity>>;
  let fileService: jest.Mocked<FileService>;

  beforeEach(async () => {
    const mockFileRepository = {
      findOneBy: jest.fn(),
      update: jest.fn(),
    };

    const mockFileService = {
      getFileContent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileParsingService,
        {
          provide: getRepositoryToken(FileEntity),
          useValue: mockFileRepository,
        },
        {
          provide: FileService,
          useValue: mockFileService,
        },
      ],
    }).compile();

    service = module.get<FileParsingService>(FileParsingService);
    fileRepository = module.get(getRepositoryToken(FileEntity));
    fileService = module.get(FileService);

    // Mock logger to avoid console output during tests
    jest.spyOn(LoggerService.prototype, 'debug').mockImplementation();
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('parseFile', () => {
    it('should parse a text file successfully', async () => {
      const fileId = 'test-file-id';
      const mockFile = {
        id: fileId,
        key: 'test-key',
        content_type: 'text/plain',
        original_name: 'test.txt',
      };
      const mockContent = new TextEncoder().encode('Hello, World!\nThis is a test file.');

      fileRepository.findOneBy.mockResolvedValue(mockFile as FileEntity);
      fileService.getFileContent.mockResolvedValue(mockContent);
      fileRepository.update.mockResolvedValue({} as any);

      await service.parseFile(fileId);

      expect(fileRepository.findOneBy).toHaveBeenCalledWith({ id: fileId });
      expect(fileService.getFileContent).toHaveBeenCalledWith({}, 'test-key');
      expect(fileRepository.update).toHaveBeenCalledTimes(2); // Once for 'processing', once for 'completed'
      
      // Check that the final update includes parsed content
      const finalUpdateCall = fileRepository.update.mock.calls[1];
      expect(finalUpdateCall[1]).toMatchObject({
        parsed_content: 'Hello, World!\nThis is a test file.',
        parsing_status: 'completed',
        parsing_error: undefined,
      });
    });

    it('should handle parsing errors gracefully', async () => {
      const fileId = 'test-file-id';
      const error = new Error('File processing failed');

      fileRepository.findOneBy.mockRejectedValue(error);
      fileRepository.update.mockResolvedValue({} as any);

      await service.parseFile(fileId);

      expect(fileRepository.update).toHaveBeenCalledWith(fileId, {
        parsing_status: 'failed',
        parsing_error: 'File processing failed',
      });
    });

    it('should handle non-text files', async () => {
      const fileId = 'test-file-id';
      const mockFile = {
        id: fileId,
        key: 'test-key',
        content_type: 'image/jpeg',
        original_name: 'test.jpg',
      };
      const mockContent = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG header

      fileRepository.findOneBy.mockResolvedValue(mockFile as FileEntity);
      fileService.getFileContent.mockResolvedValue(mockContent);
      fileRepository.update.mockResolvedValue({} as any);

      await service.parseFile(fileId);

      const finalUpdateCall = fileRepository.update.mock.calls[1];
      expect(finalUpdateCall[1]).toMatchObject({
        parsed_content: 'Binary file (image/jpeg)',
        parsing_status: 'completed',
        parsing_error: undefined,
      });
    });
  });
});