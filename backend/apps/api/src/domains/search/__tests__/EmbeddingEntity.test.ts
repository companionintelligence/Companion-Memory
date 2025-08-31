import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { UserEntity } from '../../user/entities/UserEntity';
import { EmbeddingEntity } from '../entities/EmbeddingEntity';

describe('EmbeddingEntity', () => {
  let embeddingRepository: Repository<EmbeddingEntity>;
  let userRepository: Repository<UserEntity>;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: getRepositoryToken(EmbeddingEntity),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: mockRepository,
        },
      ],
    }).compile();

    embeddingRepository = module.get<Repository<EmbeddingEntity>>(getRepositoryToken(EmbeddingEntity));
    userRepository = module.get<Repository<UserEntity>>(getRepositoryToken(UserEntity));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Vector storage and conversion', () => {
    it('should handle embedding vector as number array', () => {
      const user = new UserEntity();
      user.id = uuid7();
      user.name = 'Test User';
      user.email = 'test@example.com';

      const embeddingEntity = new EmbeddingEntity();
      embeddingEntity.id = uuid7();
      embeddingEntity.model = 'nomic-embed-text';
      embeddingEntity.raw_input = 'Hello, world!';
      embeddingEntity.raw_input_hash = 'abc123';
      embeddingEntity.entity_type = 'message';
      embeddingEntity.data_path = 'content';
      embeddingEntity.entity_id = uuid7();
      embeddingEntity.embedding_vector = [0.1, 0.2, 0.3, -0.4, 0.5];
      embeddingEntity.user = user;

      expect(embeddingEntity.embedding_vector).toEqual([0.1, 0.2, 0.3, -0.4, 0.5]);
      expect(embeddingEntity.embedding_vector.length).toBe(5);
    });

    it('should provide vector for search operations', () => {
      const user = new UserEntity();
      user.id = uuid7();
      user.name = 'Test User';
      user.email = 'test@example.com';

      const embeddingEntity = new EmbeddingEntity();
      embeddingEntity.id = uuid7();
      embeddingEntity.model = 'nomic-embed-text';
      embeddingEntity.raw_input = 'Test input';
      embeddingEntity.raw_input_hash = 'def456';
      embeddingEntity.entity_type = 'content';
      embeddingEntity.data_path = 'text';
      embeddingEntity.entity_id = uuid7();
      embeddingEntity.embedding_vector = [0.1, 0.2, 0.3];
      embeddingEntity.user = user;

      // Test without native vector
      const searchVector1 = embeddingEntity.getVectorForSearch();
      expect(searchVector1).toEqual([0.1, 0.2, 0.3]);

      // Test with native vector (should prefer native)
      embeddingEntity.embedding_vector_native = '[0.4, 0.5, 0.6]';
      const searchVector2 = embeddingEntity.getVectorForSearch();
      expect(searchVector2).toBe('[0.4, 0.5, 0.6]');
    });

    it('should convert legacy vector to native format', () => {
      const embeddingEntity = new EmbeddingEntity();
      embeddingEntity.embedding_vector = [0.1, 0.2, 0.3, 0.4];
      embeddingEntity.embedding_vector_native = undefined;

      embeddingEntity.convertToNativeVector();

      expect(embeddingEntity.embedding_vector_native).toBe('[0.1,0.2,0.3,0.4]');
    });

    it('should not overwrite existing native vector', () => {
      const embeddingEntity = new EmbeddingEntity();
      embeddingEntity.embedding_vector = [0.1, 0.2, 0.3];
      embeddingEntity.embedding_vector_native = '[0.4, 0.5, 0.6]'; // Already exists

      embeddingEntity.convertToNativeVector();

      expect(embeddingEntity.embedding_vector_native).toBe('[0.4, 0.5, 0.6]'); // Should not change
    });
  });

  describe('Data type constraints', () => {
    it('should have proper field length constraints', () => {
      const embeddingEntity = new EmbeddingEntity();
      
      // Model field should accept standard model names
      embeddingEntity.model = 'nomic-embed-text';
      expect(embeddingEntity.model).toBe('nomic-embed-text');

      // Hash should be limited length
      embeddingEntity.raw_input_hash = 'a'.repeat(64); // Max expected hash length
      expect(embeddingEntity.raw_input_hash.length).toBe(64);

      // Entity type should be limited
      embeddingEntity.entity_type = 'message';
      expect(embeddingEntity.entity_type).toBe('message');

      // Data path should handle reasonable path lengths
      embeddingEntity.data_path = 'content.nested.field.path';
      expect(embeddingEntity.data_path).toBe('content.nested.field.path');
    });

    it('should handle UUID entity_id format', () => {
      const embeddingEntity = new EmbeddingEntity();
      const testUuid = uuid7();
      
      embeddingEntity.entity_id = testUuid;
      expect(embeddingEntity.entity_id).toBe(testUuid);
      expect(embeddingEntity.entity_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  describe('Required relationships', () => {
    it('should require user relationship', () => {
      const user = new UserEntity();
      user.id = uuid7();
      user.name = 'Test User';
      user.email = 'test@example.com';

      const embeddingEntity = new EmbeddingEntity();
      embeddingEntity.user = user;

      expect(embeddingEntity.user).toBe(user);
      expect(embeddingEntity.user.id).toBe(user.id);
    });
  });
});