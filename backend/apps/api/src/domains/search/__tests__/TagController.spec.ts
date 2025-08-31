import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { QueryFailedError } from 'typeorm';

import { PgErrorCode } from '@ci/common/constants';
import { RequestContext } from '@ci/common/types';

import { TagController } from '../controllers/TagController';
import { TagService } from '../services/TagService';
import { CreateTagDto, Tag, UpdateTagDto } from '../types';

describe('TagController', () => {
  let controller: TagController;
  let service: TagService;

  const mockTagService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  const mockContext: RequestContext = {
    userId: '550e8400-e29b-41d4-a716-446655440000',
    requestId: 'test-request-id',
  };

  const mockTag: Tag = {
    id: '550e8400-e29b-41d4-a716-446655440001',
    label: 'test-tag',
    user_id: mockContext.userId!,
    created_at: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TagController],
      providers: [
        {
          provide: TagService,
          useValue: mockTagService,
        },
      ],
    }).compile();

    controller = module.get<TagController>(TagController);
    service = module.get<TagService>(TagService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should create a tag successfully', async () => {
      const createTagDto: CreateTagDto = { label: 'test-tag' };
      
      mockTagService.create.mockResolvedValue(mockTag);

      const result = await controller.create(mockContext, createTagDto);

      expect(mockTagService.create).toHaveBeenCalledWith(mockContext, createTagDto);
      expect(result).toEqual(mockTag);
    });

    it('should throw ConflictException on unique violation', async () => {
      const createTagDto: CreateTagDto = { label: 'existing-tag' };
      const uniqueViolationError = new QueryFailedError(
        'INSERT INTO tags...',
        [],
        new Error('duplicate key value violates unique constraint')
      );
      (uniqueViolationError as any).driverError = { code: PgErrorCode.UNIQUE_VIOLATION };
      
      mockTagService.create.mockRejectedValue(uniqueViolationError);

      await expect(controller.create(mockContext, createTagDto))
        .rejects.toThrow(ConflictException);
    });

    it('should rethrow other errors', async () => {
      const createTagDto: CreateTagDto = { label: 'test-tag' };
      const genericError = new Error('Database connection failed');
      
      mockTagService.create.mockRejectedValue(genericError);

      await expect(controller.create(mockContext, createTagDto))
        .rejects.toThrow(genericError);
    });
  });

  describe('findAll', () => {
    it('should return all tags', async () => {
      const tags = [mockTag];
      
      mockTagService.findAll.mockResolvedValue(tags);

      const result = await controller.findAll(mockContext);

      expect(mockTagService.findAll).toHaveBeenCalledWith(mockContext);
      expect(result).toEqual(tags);
    });
  });

  describe('findOne', () => {
    it('should return a tag by id', async () => {
      const tagId = mockTag.id;
      
      mockTagService.findOne.mockResolvedValue(mockTag);

      const result = await controller.findOne(tagId, mockContext);

      expect(mockTagService.findOne).toHaveBeenCalledWith(mockContext, tagId);
      expect(result).toEqual(mockTag);
    });

    it('should throw NotFoundException if tag not found', async () => {
      const tagId = 'nonexistent-id';
      
      mockTagService.findOne.mockResolvedValue(null);

      await expect(controller.findOne(tagId, mockContext))
        .rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update a tag successfully', async () => {
      const tagId = mockTag.id;
      const updateTagDto: UpdateTagDto = { label: 'updated-tag' };
      const updatedTag = { ...mockTag, label: 'updated-tag' };
      
      mockTagService.update.mockResolvedValue(updatedTag);

      const result = await controller.update(tagId, updateTagDto, mockContext);

      expect(mockTagService.update).toHaveBeenCalledWith(mockContext, tagId, updateTagDto);
      expect(result).toEqual(updatedTag);
    });

    it('should throw NotFoundException if tag not found', async () => {
      const tagId = 'nonexistent-id';
      const updateTagDto: UpdateTagDto = { label: 'updated-tag' };
      
      mockTagService.update.mockResolvedValue(null);

      await expect(controller.update(tagId, updateTagDto, mockContext))
        .rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException on unique violation', async () => {
      const tagId = mockTag.id;
      const updateTagDto: UpdateTagDto = { label: 'existing-tag' };
      const uniqueViolationError = new QueryFailedError(
        'UPDATE tags...',
        [],
        new Error('duplicate key value violates unique constraint')
      );
      (uniqueViolationError as any).driverError = { code: PgErrorCode.UNIQUE_VIOLATION };
      
      mockTagService.update.mockRejectedValue(uniqueViolationError);

      await expect(controller.update(tagId, updateTagDto, mockContext))
        .rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    it('should remove a tag successfully', async () => {
      const tagId = mockTag.id;
      
      mockTagService.remove.mockResolvedValue(true);

      await controller.remove(tagId, mockContext);

      expect(mockTagService.remove).toHaveBeenCalledWith(mockContext, tagId);
    });

    it('should throw NotFoundException if tag not found', async () => {
      const tagId = 'nonexistent-id';
      
      mockTagService.remove.mockResolvedValue(false);

      await expect(controller.remove(tagId, mockContext))
        .rejects.toThrow(NotFoundException);
    });
  });
});