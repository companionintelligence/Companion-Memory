import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';

import { IdFormatGuard, JwtAuthGuard } from '@ci/common/guards';
import { EventService } from '@ci/domains/events';

import { FilesModule } from '..';
import { FileEntity } from '../entities/FileEntity';
import { FileService } from '../services/FileService';

const mockCanActivate = jest.fn(() => true);

class MockJwtAuthGuard {
  canActivate = mockCanActivate;
}

describe('File routes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
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
        findOne: jest.fn().mockResolvedValue(null),
        findAll: jest.fn().mockResolvedValue([]),
        generatePresignedLink: jest.fn().mockResolvedValue('/foo'),
        upload: jest.fn(),
      })
      .overrideProvider(EventService)
      .useValue({})
      .overrideProvider(getRepositoryToken(FileEntity))
      .useValue({})
      .compile();

    app = module.createNestApplication();

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('with valid auth credentials', () => {
    it(`should return a 404 for GET → /files/foo`, () => {
      return request(app.getHttpServer()).get('/files/foo').expect(404);
    });

    it('should return a 200 for GET → /files', async () => {
      return request(app.getHttpServer()).get('/files').expect(200);
    });

    it('should return a 401 for GET → /files/upload', async () => {
      const buffer = Buffer.from('Hello, world!');

      return request(app.getHttpServer())
        .post('/files/upload')
        .attach('file', buffer, 'hello.txt')
        .expect(201);
    });

    it('should return a 200 for GET → /files/3207432f-0d07-44d6-8d56-412f5f873ec2', async () => {
      return request(app.getHttpServer()).get('/files/3207432f-0d07-44d6-8d56-412f5f873ec2').expect(200);
    });

    it('should return a 200 for GET → /files/3207432f-0d07-44d6-8d56-412f5f873ec2/presign', async () => {
      return request(app.getHttpServer())
        .post('/files/3207432f-0d07-44d6-8d56-412f5f873ec2/presign')
        .expect(200);
    });
  });

  describe('without valid auth credentials', () => {
    beforeAll(() => {
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

    it('should return a 401 for GET → /files/upload', async () => {
      return request(app.getHttpServer()).post('/files/upload').expect(401);
    });

    it('should return a 401 for GET → /files/3207432f-0d07-44d6-8d56-412f5f873ec2', async () => {
      return request(app.getHttpServer()).get('/files/3207432f-0d07-44d6-8d56-412f5f873ec2').expect(401);
    });

    it('should return a 401 for GET → /files/3207432f-0d07-44d6-8d56-412f5f873ec2/presign', async () => {
      return request(app.getHttpServer())
        .post('/files/3207432f-0d07-44d6-8d56-412f5f873ec2/presign')
        .expect(401);
    });
  });
});
