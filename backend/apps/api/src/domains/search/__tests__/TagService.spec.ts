import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RequestContext } from '@ci/common/types';

import { TagEntity } from '../entities/TagEntity';
import { TagService } from '../services/TagService';
import { CreateTagDto, UpdateTagDto } from '../types';

describe('TagService', () => {
  let service: TagService;
  let repository: Repository<TagEntity>;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  const mockContext: RequestContext = {
    userId: '550e8400-e29b-41d4-a716-446655440000',
    requestId: 'test-request-id',
  };

  const mockTagEntity = {
    id: '550e8400-e29b-41d4-a716-446655440001',
    label: 'test-tag',
    user: { id: mockContext.userId! } as any,
    created_at: new Date(),
    toTag: jest.fn().mockReturnValue('test-tag'),
  } as any as TagEntity;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TagService,
        {
          provide: getRepositoryToken(TagEntity),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<TagService>(TagService);
    repository = module.get<Repository<TagEntity>>(getRepositoryToken(TagEntity));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a new tag', async () => {
      const createTagDto: CreateTagDto = { label: 'test-tag' };
      
      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.create.mockReturnValue(mockTagEntity);
      mockRepository.save.mockResolvedValue(mockTagEntity);

      const result = await service.create(mockContext, createTagDto);

      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: {
          label: createTagDto.label.toLowerCase(),
          user: { id: mockContext.userId },
        },
      });
      expect(result).toEqual({
        id: mockTagEntity.id,
        label: mockTagEntity.label,
        user_id: mockContext.userId,
        created_at: mockTagEntity.created_at,
      });
    });

    it('should return existing tag if already exists', async () => {
      const createTagDto: CreateTagDto = { label: 'existing-tag' };
      
      mockRepository.findOne.mockResolvedValue(mockTagEntity);

      const result = await service.create(mockContext, createTagDto);

      expect(mockRepository.create).not.toHaveBeenCalled();
      expect(mockRepository.save).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: mockTagEntity.id,
        label: mockTagEntity.label,
        user_id: mockContext.userId,
        created_at: mockTagEntity.created_at,
      });
    });
  });

  describe('findAll', () => {
    it('should return all tags for a user', async () => {
      mockRepository.find.mockResolvedValue([mockTagEntity]);

      const result = await service.findAll(mockContext);

      expect(mockRepository.find).toHaveBeenCalledWith({
        where: { user: { id: mockContext.userId } },
        relations: ['user'],
        order: { created_at: 'DESC' },
      });
      expect(result).toEqual([{
        id: mockTagEntity.id,
        label: mockTagEntity.label,
        user_id: mockContext.userId,
        created_at: mockTagEntity.created_at,
      }]);
    });
  });

  describe('findOne', () => {
    it('should return a tag by id', async () => {
      const tagId = mockTagEntity.id;
      
      mockRepository.findOne.mockResolvedValue(mockTagEntity);

      const result = await service.findOne(mockContext, tagId);

      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { id: tagId, user: { id: mockContext.userId } },
        relations: ['user'],
      });
      expect(result).toEqual({
        id: mockTagEntity.id,
        label: mockTagEntity.label,
        user_id: mockContext.userId,
        created_at: mockTagEntity.created_at,
      });
    });

    it('should return null if tag not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      const result = await service.findOne(mockContext, 'nonexistent-id');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update a tag', async () => {
      const tagId = mockTagEntity.id;
      const updateTagDto: UpdateTagDto = { label: 'updated-tag' };
      const updatedEntity = { ...mockTagEntity, label: 'updated-tag' };
      
      // Mock findOne to return the tag twice (for existence check and after update)
      mockRepository.findOne
        .mockResolvedValueOnce(mockTagEntity)  // First call for existence check
        .mockResolvedValueOnce(updatedEntity); // Second call after update
      mockRepository.update.mockResolvedValue({ affected: 1 });

      const result = await service.update(mockContext, tagId, updateTagDto);

      expect(mockRepository.update).toHaveBeenCalledWith(tagId, {
        label: updateTagDto.label,
      });
      expect(result).toEqual({
        id: updatedEntity.id,
        label: updatedEntity.label,
        user_id: mockContext.userId,
        created_at: updatedEntity.created_at,
      });
    });

    it('should return null if tag not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      const result = await service.update(mockContext, 'nonexistent-id', { label: 'test' });

      expect(result).toBeNull();
    });
  });

  describe('remove', () => {
    it('should remove a tag', async () => {
      const tagId = mockTagEntity.id;
      
      mockRepository.findOne.mockResolvedValue(mockTagEntity);
      mockRepository.delete.mockResolvedValue({ affected: 1 });

      const result = await service.remove(mockContext, tagId);

      expect(mockRepository.delete).toHaveBeenCalledWith(tagId);
      expect(result).toBe(true);
    });

    it('should return false if tag not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      const result = await service.remove(mockContext, 'nonexistent-id');

      expect(result).toBe(false);
      expect(mockRepository.delete).not.toHaveBeenCalled();
    });
  });
});