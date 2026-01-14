import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import { IdFormatGuard, JwtAuthGuard } from '@ci/common/guards';
import { EventService } from '@ci/domains/events';

import { FilesModule } from '..';
import { FileEntity } from '../entities/FileEntity';
import { SavedSearchEntity } from '../entities/SavedSearchEntity';
import { FileService } from '../services/FileService';

const mockCanActivate = jest.fn();

class MockJwtAuthGuard {
  canActivate = mockCanActivate;
}

describe('File routes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    mockCanActivate.mockImplementation(() => true);

    const repositoryTokensToMock = [
      getRepositoryToken(FileEntity),
      getRepositoryToken(SavedSearchEntity),
      'PgBossJobEntityRepository',
      'PgBossArchiveEntityRepository',
      'PgBossScheduleEntityRepository',
      'PgBossQueueEntityRepository',
    ];

    let moduleBuilder = Test.createTestingModule({
      imports: [FilesModule],
      providers: [
        {
          provide: APP_GUARD,
          useClass: IdFormatGuard,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(MockJwtAuthGuard)
      .overrideProvider(FileService)
      .useValue({
        findById: jest.fn().mockResolvedValue(null),
        findAll: jest.fn().mockResolvedValue([]),
        generatePresignedLink: jest.fn().mockResolvedValue('/foo'),
        upload: jest.fn(),
      })
      .overrideProvider(EventService)
      .useValue({});

    moduleBuilder = repositoryTokensToMock.reduce(
      (builder, token) => builder.overrideProvider(token).useValue({}),
      moduleBuilder satisfies TestingModuleBuilder,
    );

    const module = await moduleBuilder.compile();

    app = module.createNestApplication();

    // Manually set up the context middleware to inject the user into AsyncLocalStorage
    // This replaces the standard RequestContextMiddleware for testing purposes
    app.use((req: Request, res: Response, next: NextFunction) => {
      ContextService.run(
        {
          traceId: 'test-trace-id',
          userId: 'test-user-id', // Inject the user ID into the async storage
        },
        () => {
          next();
        },
      );
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('with valid auth credentials', () => {
    beforeEach(() => {
      mockCanActivate.mockImplementation(() => true);
    });

    it(`should return a 404 for GET → /files/foo`, () => {
      return request(app.getHttpServer()).get('/files/foo').expect(404);
    });

    it('should return a 200 for GET → /files', async () => {
      return request(app.getHttpServer()).get('/files').expect(200);
    });

    it('should return a 201 for POST → /files/upload', async () => {
      const buffer = Buffer.from('Hello, world!');

      return request(app.getHttpServer())
        .post('/files/upload')
        .attach('files', buffer, 'hello.txt')
        .expect(201);
    });

    it('should return a 200 for GET → /files/3207432f-0d07-44d6-8d56-412f5f873ec2', async () => {
      return request(app.getHttpServer()).get('/files/3207432f-0d07-44d6-8d56-412f5f873ec2').expect(200);
    });

    it('should return a 200 for POST → /files/3207432f-0d07-44d6-8d56-412f5f873ec2/presign', async () => {
      return request(app.getHttpServer())
        .post('/files/3207432f-0d07-44d6-8d56-412f5f873ec2/presign')
        .expect(200);
    });
  });

  describe('without valid auth credentials', () => {
    beforeEach(() => {
      mockCanActivate.mockImplementation(() => {
        throw new UnauthorizedException();
      });
    });

    it(`should return a 404 for GET → /files/foo`, () => {
      return request(app.getHttpServer()).get('/files/foo').expect(404);
    });

    it('should return a 401 for GET → /files', async () => {
      return request(app.getHttpServer()).get('/files').expect(401);
    });

    it('should return a 401 for POST → /files/upload', async () => {
      return request(app.getHttpServer()).post('/files/upload').expect(401);
    });

    it('should return a 401 for GET → /files/3207432f-0d07-44d6-8d56-412f5f873ec2', async () => {
      return request(app.getHttpServer()).get('/files/3207432f-0d07-44d6-8d56-412f5f873ec2').expect(401);
    });

    it('should return a 401 for POST → /files/3207432f-0d07-44d6-8d56-412f5f873ec2/presign', async () => {
      return request(app.getHttpServer())
        .post('/files/3207432f-0d07-44d6-8d56-412f5f873ec2/presign')
        .expect(401);
    });
  });
});
