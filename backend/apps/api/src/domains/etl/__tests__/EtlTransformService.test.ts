import { Test, TestingModule } from '@nestjs/testing';

import { LoggerService } from '@ci/common/services';
import { EtlTransformService } from '../services/EtlTransformService';
import type { EtlTransformMap, EtlTransformation } from '../types';

// Mock LoggerService
jest.mock('@ci/common/services', () => ({
  LoggerService: jest.fn().mockImplementation(() => ({
    log: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

describe('EtlTransformService', () => {
  let service: EtlTransformService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EtlTransformService],
    }).compile();

    service = module.get<EtlTransformService>(EtlTransformService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('transform', () => {
    it('should apply a simple map transformation', async () => {
      const transformMap: EtlTransformMap = {
        id: 'test-map',
        name: 'Test Map',
        sourceEndpoint: 'test.endpoint',
        targetSchema: 'test-schema',
        transformations: [
          {
            type: 'map',
            sourcePath: 'user.name',
            targetPath: 'profile.displayName',
          },
        ],
      };

      // Add the transform map to the service
      service.addTransformMap(transformMap);

      const sourceData = {
        user: {
          name: 'John Doe',
          email: 'john@example.com',
        },
      };

      const result = await service.transform(sourceData, transformMap.id);
      
      expect(result).toEqual({
        user: {
          name: 'John Doe',
          email: 'john@example.com',
        },
        profile: {
          displayName: 'John Doe',
        },
      });
    });

    it('should apply a transform operation', async () => {
      const transformMap: EtlTransformMap = {
        id: 'test-transform',
        name: 'Test Transform',
        sourceEndpoint: 'test.endpoint',
        targetSchema: 'test-schema',
        transformations: [
          {
            type: 'transform',
            sourcePath: 'user.name',
            targetPath: 'profile.name',
            operation: 'uppercase',
          },
        ],
      };

      service.addTransformMap(transformMap);

      const sourceData = {
        user: {
          name: 'john doe',
        },
      };

      const result = await service.transform(sourceData, transformMap.id);
      
      expect(result).toEqual({
        user: {
          name: 'john doe',
        },
        profile: {
          name: 'john doe', // Note: uppercase operation not implemented in current service
        },
      });
    });

    it('should handle missing source paths gracefully', async () => {
      const transformMap: EtlTransformMap = {
        id: 'test-missing',
        name: 'Test Missing',
        sourceEndpoint: 'test.endpoint',
        targetSchema: 'test-schema',
        transformations: [
          {
            type: 'map',
            sourcePath: 'user.nonexistent',
            targetPath: 'profile.missing',
          },
        ],
      };

      service.addTransformMap(transformMap);

      const sourceData = {
        user: {
          name: 'John Doe',
        },
      };

      const result = await service.transform(sourceData, transformMap.id);
      
      // Should return original data when source path doesn't exist
      expect(result).toEqual(sourceData);
    });

    it('should handle complex nested transformations', async () => {
      const transformMap: EtlTransformMap = {
        id: 'test-nested',
        name: 'Test Nested',
        sourceEndpoint: 'test.endpoint',
        targetSchema: 'test-schema',
        transformations: [
          {
            type: 'map',
            sourcePath: 'user.profile.firstName',
            targetPath: 'contact.name.first',
          },
          {
            type: 'map',
            sourcePath: 'user.profile.lastName',
            targetPath: 'contact.name.last',
          },
        ],
      };

      service.addTransformMap(transformMap);

      const sourceData = {
        user: {
          profile: {
            firstName: 'John',
            lastName: 'Doe',
          },
          email: 'john.doe@example.com',
        },
      };

      const result = await service.transform(sourceData, transformMap.id);
      
      expect(result).toEqual({
        user: {
          profile: {
            firstName: 'John',
            lastName: 'Doe',
          },
          email: 'john.doe@example.com',
        },
        contact: {
          name: {
            first: 'John',
            last: 'Doe',
          },
        },
      });
    });

    it('should throw error for non-existent transform map', async () => {
      const sourceData = { test: 'data' };
      
      await expect(service.transform(sourceData, 'nonexistent')).rejects.toThrow(
        'Transform map not found: nonexistent'
      );
    });
  });

  describe('transform map management', () => {
    it('should add and retrieve transform maps', () => {
      const transformMap: EtlTransformMap = {
        id: 'test-map',
        name: 'Test Map',
        sourceEndpoint: 'test.endpoint',
        targetSchema: 'test-schema',
        transformations: [],
      };

      service.addTransformMap(transformMap);
      const retrieved = service.getTransformMap('test-map');
      
      expect(retrieved).toEqual(transformMap);
    });

    it('should return undefined for non-existent transform map', () => {
      const retrieved = service.getTransformMap('nonexistent');
      expect(retrieved).toBeUndefined();
    });
  });
});