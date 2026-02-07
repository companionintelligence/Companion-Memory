/**
 * Transform Engine Integration Tests
 * 
 * Tests data transformation, field mapping, and type conversion
 */

import { Test, TestingModule } from '@nestjs/testing';

import { LoggerService } from '@ci/common/logging';
import { createMockLogger } from '@ci/test/mocks';

import { TransformEngine } from '../../services/TransformEngine';
import type { TransformMap, FieldMapping } from '../../types/transform';

describe('TransformEngine Integration Tests', () => {
  let transformEngine: TransformEngine;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        TransformEngine,
        {
          provide: LoggerService,
          useValue: createMockLogger(),
        },
      ],
    }).compile();

    transformEngine = module.get<TransformEngine>(TransformEngine);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('Direct Field Mapping', () => {
    it('should map direct fields correctly', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            required: true,
          },
          title: {
            type: 'direct',
            source: 'name',
            required: false,
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = [
        { id: '123', name: 'Test Item' },
        { id: '456', name: 'Another Item' },
      ];

      const result = await transformEngine.transform(rawData, transformMap);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toMatchObject({
        externalId: '123',
        title: 'Test Item',
      });
    });

    it('should handle missing required fields', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            required: true,
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = [{ name: 'Test Item' }]; // Missing 'id'

      const result = await transformEngine.transform(rawData, transformMap);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('should use default values for missing optional fields', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            required: true,
          },
          title: {
            type: 'direct',
            source: 'name',
            required: false,
            default: 'Untitled',
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = [{ id: '123' }]; // Missing 'name'

      const result = await transformEngine.transform(rawData, transformMap);

      expect(result.success).toBe(true);
      expect(result.data[0]).toMatchObject({
        externalId: '123',
        title: 'Untitled',
      });
    });
  });

  describe('Nested Field Mapping', () => {
    it('should extract nested field values', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            required: true,
          },
          authorName: {
            type: 'nested',
            path: 'author.name',
            required: false,
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = [
        {
          id: '123',
          author: { name: 'John Doe', email: 'john@example.com' },
        },
      ];

      const result = await transformEngine.transform(rawData, transformMap);

      expect(result.success).toBe(true);
      expect(result.data[0]).toMatchObject({
        externalId: '123',
        authorName: 'John Doe',
      });
    });

    it('should handle deeply nested paths', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            required: true,
          },
          city: {
            type: 'nested',
            path: 'user.address.city',
            required: false,
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = [
        {
          id: '123',
          user: {
            address: {
              city: 'New York',
              country: 'USA',
            },
          },
        },
      ];

      const result = await transformEngine.transform(rawData, transformMap);

      expect(result.success).toBe(true);
      expect(result.data[0].city).toBe('New York');
    });
  });

  describe('Constant Mapping', () => {
    it('should set constant values', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            required: true,
          },
          type: {
            type: 'constant',
            constantValue: 'email',
          },
          platform: {
            type: 'constant',
            constantValue: 'gmail',
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = [{ id: '123' }];

      const result = await transformEngine.transform(rawData, transformMap);

      expect(result.success).toBe(true);
      expect(result.data[0]).toMatchObject({
        externalId: '123',
        type: 'email',
        platform: 'gmail',
      });
    });
  });

  describe('Type Transformations', () => {
    it('should convert date strings to Date objects', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            required: true,
          },
          timestamp: {
            type: 'direct',
            source: 'created_at',
            transform: {
              type: 'date',
              format: 'iso8601',
            },
            required: true,
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = [
        {
          id: '123',
          created_at: '2024-01-15T10:30:00Z',
        },
      ];

      const result = await transformEngine.transform(rawData, transformMap);

      expect(result.success).toBe(true);
      expect(result.data[0].timestamp).toBeInstanceOf(Date);
    });

    it('should convert unix timestamps to Date objects', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            required: true,
          },
          timestamp: {
            type: 'direct',
            source: 'created_timestamp',
            transform: {
              type: 'date',
              format: 'unix_ms',
            },
            required: true,
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = [
        {
          id: '123',
          created_timestamp: 1705316400000,
        },
      ];

      const result = await transformEngine.transform(rawData, transformMap);

      expect(result.success).toBe(true);
      expect(result.data[0].timestamp).toBeInstanceOf(Date);
    });

    it('should convert numbers to strings', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            transform: {
              type: 'string',
            },
            required: true,
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = [{ id: 12345 }];

      const result = await transformEngine.transform(rawData, transformMap);

      expect(result.success).toBe(true);
      expect(result.data[0].externalId).toBe('12345');
      expect(typeof result.data[0].externalId).toBe('string');
    });
  });

  describe('Bulk Transform', () => {
    it('should transform large batches efficiently', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            required: true,
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}` }));

      const startTime = Date.now();
      const result = await transformEngine.transform(rawData, transformMap);
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1000);
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });

    it('should collect all errors when multiple items fail', async () => {
      const transformMap: TransformMap = {
        id: 'test_transform',
        name: 'Test Transform',
        description: 'Test',
        sourceType: 'test_source',
        targetType: 'test_target',
        fields: {
          externalId: {
            type: 'direct',
            source: 'id',
            required: true,
          },
        },
        transformers: [],
        metadata: {},
        enabled: true,
      };

      const rawData = [
        { id: '1' },
        { name: 'missing id' },
        { id: '3' },
        { name: 'another missing id' },
      ];

      const result = await transformEngine.transform(rawData, transformMap);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });
});
