import { type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { IdFormatGuard, JwtAuthGuard } from '@ci/common/guards';

import { EtlController } from '../controllers/EtlController';
import { EtlCollectionService } from '../services/EtlCollectionService';
import { EtlTransformService } from '../services/EtlTransformService';

const mockCanActivate = jest.fn(() => true);

class MockJwtAuthGuard {
  canActivate = mockCanActivate;
}

const mockEtlCollectionService = {
  createJob: jest.fn(),
  getJob: jest.fn(),
  updateJob: jest.fn(),
  deleteJob: jest.fn(),
};

const mockEtlTransformService = {
  transform: jest.fn(),
  getTransformMap: jest.fn(),
  addTransformMap: jest.fn(),
};

describe('ETL routes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [EtlController],
      providers: [
        {
          provide: APP_GUARD,
          useClass: IdFormatGuard,
        },
        {
          provide: EtlCollectionService,
          useValue: mockEtlCollectionService,
        },
        {
          provide: EtlTransformService,
          useValue: mockEtlTransformService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(MockJwtAuthGuard)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanActivate.mockReturnValue(true);
  });

  describe('with valid auth credentials', () => {
    it('should return endpoints for GET → /etl/endpoints', async () => {
      const response = await request(app.getHttpServer())
        .get('/etl/endpoints')
        .expect(200);
      
      expect(response.body).toHaveProperty('endpoints');
      expect(Array.isArray(response.body.endpoints)).toBe(true);
      expect(response.body.endpoints.length).toBeGreaterThan(0);
      
      // Should have Google, Microsoft, Dropbox, and Meta endpoints
      const providers = [...new Set(response.body.endpoints.map((e: any) => e.provider))];
      expect(providers).toContain('google');
      expect(providers).toContain('microsoft');
      expect(providers).toContain('dropbox');
      expect(providers).toContain('meta');
    });

    it('should return provider-specific endpoints for GET → /etl/endpoints/google', async () => {
      const response = await request(app.getHttpServer())
        .get('/etl/endpoints/google')
        .expect(200);
      
      expect(response.body).toHaveProperty('endpoints');
      expect(Array.isArray(response.body.endpoints)).toBe(true);
      
      // All endpoints should be for Google
      response.body.endpoints.forEach((endpoint: any) => {
        expect(endpoint.provider).toBe('google');
      });
    });

    it('should return empty array for non-existent provider GET → /etl/endpoints/nonexistent', async () => {
      const response = await request(app.getHttpServer())
        .get('/etl/endpoints/nonexistent')
        .expect(200);
      
      expect(response.body).toHaveProperty('endpoints');
      expect(response.body.endpoints).toEqual([]);
    });
  });

  describe('without valid auth credentials', () => {
    beforeEach(() => {
      mockCanActivate.mockReturnValue(false);
    });

    it('should return 403 for GET → /etl/endpoints', async () => {
      await request(app.getHttpServer())
        .get('/etl/endpoints')
        .expect(403);
    });

    it('should return 403 for GET → /etl/endpoints/google', async () => {
      await request(app.getHttpServer())
        .get('/etl/endpoints/google')
        .expect(403);
    });
  });
});