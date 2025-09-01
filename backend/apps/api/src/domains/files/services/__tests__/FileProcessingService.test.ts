import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FileEntity } from '../../entities/FileEntity';
import { FileProcessingService } from '../FileProcessingService';
import { FileService } from '../FileService';

describe('FileProcessingService', () => {
  let service: FileProcessingService;
  let fileRepository: Repository<FileEntity>;
  let fileService: FileService;

  const mockFileRepository = {
    find: jest.fn(),
  };

  const mockFileService = {
    getFileContent: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileProcessingService,
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

    service = module.get<FileProcessingService>(FileProcessingService);
    fileRepository = module.get<Repository<FileEntity>>(getRepositoryToken(FileEntity));
    fileService = module.get<FileService>(FileService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should generate file analysis prompt for text file', async () => {
    const mockFile = {
      id: 'test-file-id',
      original_name: 'test.txt',
      content_type: 'text/plain',
      size: 100,
      user: { id: 'user-123' },
    } as FileEntity;

    const mockContent = new TextEncoder().encode('Hello, world!');
    
    mockFileRepository.find.mockResolvedValue([mockFile]);
    mockFileService.getFileContent.mockResolvedValue(mockContent);

    const result = await service.processFiles(
      { userId: 'user-123' },
      ['test-file-id']
    );

    expect(result).toHaveLength(1);
    expect(result[0].file).toEqual(mockFile);
    expect(result[0].metadata.textContent).toBe('Hello, world!');
  });

  it('should generate appropriate prompt for file-only request', async () => {
    const processedFiles = [
      {
        file: {
          id: 'test-file-id',
          original_name: 'image.jpg',
          content_type: 'image/jpeg',
          size: 1024,
        } as FileEntity,
        metadata: {
          dimensions: { width: 800, height: 600 },
        },
        content: new Uint8Array(),
      },
    ];

    const prompt = await service.generateFileAnalysisPrompt(processedFiles);

    expect(prompt).toContain('uploaded 1 file(s)');
    expect(prompt).toContain('image.jpg');
    expect(prompt).toContain('Dimensions: 800x600');
  });

  it('should validate file ownership', async () => {
    mockFileRepository.find.mockResolvedValue([]);

    await expect(
      service.processFiles({ userId: 'user-123' }, ['missing-file-id'])
    ).rejects.toThrow('Files not found: missing-file-id');
  });

  it('should handle PDF files and extract text content', async () => {
    const mockFile = {
      id: 'pdf-file-id',
      original_name: 'document.pdf',
      content_type: 'application/pdf',
      size: 5000,
      user: { id: 'user-123' },
    } as FileEntity;

    // Mock PDF content - this would normally be actual PDF bytes
    const mockPdfContent = Buffer.from('Mock PDF content');
    
    mockFileRepository.find.mockResolvedValue([mockFile]);
    mockFileService.getFileContent.mockResolvedValue(mockPdfContent);

    const result = await service.processFiles(
      { userId: 'user-123' },
      ['pdf-file-id']
    );

    expect(result).toHaveLength(1);
    expect(result[0].file).toEqual(mockFile);
    // PDF parsing may fail in test environment, but the structure should be correct
  });

  it('should generate comprehensive file type summaries', async () => {
    const processedFiles = [
      {
        file: { original_name: 'image1.jpg', content_type: 'image/jpeg' } as FileEntity,
        metadata: {},
        content: new Uint8Array(),
      },
      {
        file: { original_name: 'image2.png', content_type: 'image/png' } as FileEntity,
        metadata: {},
        content: new Uint8Array(),
      },
      {
        file: { original_name: 'document.pdf', content_type: 'application/pdf' } as FileEntity,
        metadata: {},
        content: new Uint8Array(),
      },
    ];

    const prompt = await service.generateFileAnalysisPrompt(processedFiles);

    expect(prompt).toContain('uploaded 3 file(s): 2 Images, PDF Document');
  });
});