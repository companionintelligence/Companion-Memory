import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { BodyParserMiddleware } from '@ci/common/middleware';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import { CommunicationService, ContentService, ItemService } from '@ci/domains/memory';
import { PositionService } from '@ci/domains/position';

import { BulkIngestController } from '../controllers/BulkIngestController';

const mockCanActivate = jest.fn();

class MockJwtAuthGuard {
  canActivate = mockCanActivate;
}

/**
 * Wire the /v1 bulk routes the way production does — `bodyParser: false` (as
 * in main.ts) with BodyParserMiddleware applied manually — so these tests
 * exercise the REAL content-type switch: JSON envelopes parsed by the
 * middleware, NDJSON left as a raw stream for the handler.
 */
describe('Bulk ingest routes (/v1/*)', () => {
  let app: INestApplication;

  const echo = async (_context: unknown, data: unknown[]) => data.map((_, i) => ({ id: `row-${i}` }));

  const communicationService = { createMany: jest.fn(echo) };
  const contentService = { createMany: jest.fn(echo) };
  const itemService = { createMany: jest.fn(echo) };
  const browserActivityService = { createMany: jest.fn(echo) };
  const positionService = { create: jest.fn(echo) };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanActivate.mockImplementation(() => true);
    communicationService.createMany.mockImplementation(echo);
    itemService.createMany.mockImplementation(echo);
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BulkIngestController],
      providers: [
        { provide: CommunicationService, useValue: communicationService },
        { provide: ContentService, useValue: contentService },
        { provide: ItemService, useValue: itemService },
        { provide: BrowserActivityService, useValue: browserActivityService },
        { provide: PositionService, useValue: positionService },
      ],
    })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useClass(MockJwtAuthGuard)
      .compile();

    app = module.createNestApplication({ bodyParser: false });

    // Same shape as production main.ts/application.ts: context middleware,
    // then the selective body parser.
    app.use((req: Request, res: Response, next: NextFunction) => {
      ContextService.run({ traceId: 'test-trace-id', userId: 'test-user-id' }, () => next());
    });

    const bodyParser = new BodyParserMiddleware(new Reflector());
    app.use((req: Request, res: Response, next: NextFunction) => bodyParser.use(req, res, next));

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const commLine = (sourceId: string) =>
    JSON.stringify({
      time: '2026-01-01T00:00:00.000Z',
      communication_type: 'email',
      content: 'hello',
      source_type: 'communication',
      source_system: 'gmail',
      source_id: sourceId,
    });

  describe('JSON envelope (unchanged contract)', () => {
    it('POST /v1/communications ingests a { records } envelope', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/communications')
        .send({ records: [JSON.parse(commLine('a')), JSON.parse(commLine('b'))] })
        .expect(201);

      expect(res.body).toEqual({ ingested: 2, duplicate: 0, rejected: [] });
      expect(communicationService.createMany).toHaveBeenCalledTimes(1);
      expect(communicationService.createMany.mock.calls[0][1]).toHaveLength(2);
    });

    it('rejects a bad envelope with the ValidationPipe 400 shape', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/communications')
        .send({ records: [{ content: 'missing everything' }] })
        .expect(400);

      expect(res.body.message).toBe('Validation failed');
      expect(communicationService.createMany).not.toHaveBeenCalled();
    });
  });

  describe('NDJSON streaming (the default bulk contract)', () => {
    it('POST /v1/communications ingests one record per line', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/communications')
        .set('content-type', 'application/x-ndjson')
        .send(`${commLine('a')}\n${commLine('b')}\n${commLine('c')}\n`)
        .expect(201);

      expect(res.body).toEqual({ ingested: 3, duplicate: 0, rejected: [] });
      const dtos = communicationService.createMany.mock.calls[0][1] as { direction: string }[];
      expect(dtos).toHaveLength(3);
      expect(dtos[0].direction).toBe('inbound');
    });

    it('flushes to the service in batches while the stream arrives', async () => {
      const lines = Array.from({ length: 2500 }, (_, i) => JSON.stringify({ name: `Item ${i}` })).join('\n');

      const res = await request(app.getHttpServer())
        .post('/v1/inventory')
        .set('content-type', 'application/x-ndjson')
        .send(lines)
        .expect(201);

      expect(res.body).toEqual({ ingested: 2500, duplicate: 0, rejected: [] });
      expect(itemService.createMany).toHaveBeenCalledTimes(3);
      expect(itemService.createMany.mock.calls.map((call) => (call[1] as unknown[]).length)).toEqual([
        1000, 1000, 500,
      ]);
    });

    it('rejects malformed lines by 1-based number without aborting the stream', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/communications')
        .set('content-type', 'application/x-ndjson')
        .send(`${commLine('a')}\nnot json at all\n${commLine('b')}\n`)
        .expect(201);

      expect(res.body.ingested).toBe(2);
      expect(res.body.rejected).toEqual([{ line: 2, reason: expect.stringContaining('invalid JSON') }]);
    });

    it('exceeds the 10mb JSON envelope limit without a 413 (NDJSON has no overall cap)', async () => {
      // ~15 MB of NDJSON — over the envelope path's 10mb body limit. The
      // middleware bypass means no parser buffers it; batches flush as the
      // stream arrives.
      const filler = 'x'.repeat(1024);
      const count = 15 * 1024;
      const body = Array.from(
        { length: count },
        (_, i) => `${JSON.stringify({ name: `Item ${i}`, description: filler })}\n`,
      ).join('');

      const res = await request(app.getHttpServer())
        .post('/v1/inventory')
        .set('content-type', 'application/x-ndjson')
        .send(body)
        .expect(201);

      expect(res.body.ingested).toBe(count);
      expect(res.body.rejected).toEqual([]);
    });
  });

  describe('auth', () => {
    beforeEach(() => {
      mockCanActivate.mockImplementation(() => {
        throw new UnauthorizedException();
      });
    });

    it('401s an NDJSON stream before any batch is flushed (guard runs before the handler streams)', async () => {
      await request(app.getHttpServer())
        .post('/v1/communications')
        .set('content-type', 'application/x-ndjson')
        .send(`${commLine('a')}\n`)
        .expect(401);

      expect(communicationService.createMany).not.toHaveBeenCalled();
    });

    it('401s the JSON envelope path too', async () => {
      await request(app.getHttpServer())
        .post('/v1/communications')
        .send({ records: [JSON.parse(commLine('a'))] })
        .expect(401);

      expect(communicationService.createMany).not.toHaveBeenCalled();
    });
  });
});
