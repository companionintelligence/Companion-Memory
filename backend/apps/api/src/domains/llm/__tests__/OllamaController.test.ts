import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { NextFunction, Response } from 'express';
import request from 'supertest';

import { IdFormatGuard, JwtAuthGuard } from '@ci/common/guards';
import type { RequestWithContext } from '@ci/common/types';
import { EventService } from '@ci/domains/events';
import { LLMModule, MessageEntity, OllamaService, ThreadEntity } from '@ci/domains/llm';

import { MessageService } from '../services/MessageService';
import { ThreadService } from '../services/ThreadService';

const mockCanActivate = jest.fn(() => true);

class MockJwtAuthGuard {
  canActivate = mockCanActivate;
}

const TEST_PROMPT = 'Explain quantum entanglement.';
const VIRTUAL_FILE = {
  buffer: Buffer.from('Hello, world!'),
  options: {
    filename: 'hello.txt',
    contentType: 'text/plain',
  },
};

describe('OllamaController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [LLMModule],
      providers: [
        {
          provide: APP_GUARD,
          useClass: IdFormatGuard,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(MockJwtAuthGuard)
      .overrideProvider(EventService)
      .useValue({
        send: jest.fn(),
      })
      .overrideProvider(MessageService)
      .useValue({
        create: jest.fn().mockResolvedValue({
          id: 'test',
        }),
        update: jest.fn(),
        findByThread: jest.fn().mockResolvedValue([]),
      })
      .overrideProvider(OllamaService)
      .useValue({
        chatStream: jest.fn(async () => {
          const generator = (async function* () {
            // No chat message chunk yields.
          })();

          return Object.assign(generator, { buffer: 'mock response' });
        }),
        validateModel: jest.fn().mockResolvedValue('test-model'),
      })
      .overrideProvider(ThreadService)
      .useValue({
        exists: jest.fn().mockResolvedValue(true),
        create: jest.fn().mockResolvedValue({
          id: 'test',
        }),
      })
      .overrideProvider(getRepositoryToken(MessageEntity))
      .useValue({})
      .overrideProvider(getRepositoryToken(ThreadEntity))
      .useValue({})
      .compile();

    app = module.createNestApplication();

    app.use((req: RequestWithContext, _res: Response, next: NextFunction) => {
      req.context = {
        userId: 'mock-user',
      };

      next();
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('with valid auth credentials', () => {
    beforeAll(() => {
      mockCanActivate.mockImplementation(() => true);
    });

    it('should handle JSON body with no attachments', () => {
      return request(app.getHttpServer())
        .post('/llm/generate')
        .set('Content-Type', 'application/json')
        .send({ prompt: TEST_PROMPT })
        .expect(200);
    });

    it('should handle multipart body with input and no attachments', () => {
      return request(app.getHttpServer())
        .post('/llm/generate')
        .field('input', JSON.stringify({ prompt: TEST_PROMPT }))
        .expect(200);
    });

    it('should handle one attachment and input', () => {
      return request(app.getHttpServer())
        .post('/llm/generate')
        .field('input', JSON.stringify({ prompt: TEST_PROMPT }))
        .attach('attachments', VIRTUAL_FILE.buffer, VIRTUAL_FILE.options)
        .expect(200);
    });

    it('should handle multiple attachments and input', () => {
      return request(app.getHttpServer())
        .post('/llm/generate')
        .field('input', JSON.stringify({ prompt: TEST_PROMPT }))
        .attach('attachments', VIRTUAL_FILE.buffer, VIRTUAL_FILE.options)
        .attach('attachments', VIRTUAL_FILE.buffer, VIRTUAL_FILE.options)
        .expect(200);
    });

    it('should handle no input or attachments', () => {
      return request(app.getHttpServer()).post('/llm/generate').expect(400);
    });

    it('should handle multiple attachments and no input', () => {
      return request(app.getHttpServer())
        .post('/llm/generate')
        .attach('attachments', VIRTUAL_FILE.buffer, VIRTUAL_FILE.options)
        .attach('attachments', VIRTUAL_FILE.buffer, VIRTUAL_FILE.options)
        .expect(200);
    });
  });

  describe('without valid auth credentials', () => {
    beforeAll(() => {
      mockCanActivate.mockImplementation(() => {
        throw new UnauthorizedException();
      });
    });

    it('should return 401 for JSON body', () => {
      return request(app.getHttpServer())
        .post('/llm/generate')
        .set('Content-Type', 'application/json')
        .send({ prompt: TEST_PROMPT })
        .expect(401);
    });

    it('should return 401 for multipart with input', () => {
      return request(app.getHttpServer())
        .post('/llm/generate')
        .field('input', JSON.stringify({ prompt: TEST_PROMPT }))
        .expect(401);
    });

    it('should return 401 for multipart with attachments', () => {
      return request(app.getHttpServer())
        .post('/llm/generate')
        .attach('attachments', VIRTUAL_FILE.buffer, VIRTUAL_FILE.options)
        .expect(401);
    });
  });
});
