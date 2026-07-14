import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { BulkFilesController } from '../controllers/BulkFilesController';
import { FileService } from '../services/FileService';

const mockCanActivate = jest.fn();

class MockJwtAuthGuard {
  canActivate = mockCanActivate;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('POST /v1/files (batch upload)', () => {
  let app: INestApplication;

  // Simulated store: content hash → id, so a second upload of the same bytes
  // (across requests) reports deduped, like the real hash-dedup pipeline.
  const stored = new Map<string, string>();
  let nextId = 1;

  const readUpload = (dto: { buffer?: Buffer; path?: string }) => dto.buffer ?? readFileSync(dto.path!);

  const fileService = {
    getFileHash: jest.fn(async (dto: { buffer?: Buffer; path?: string }) => sha256(readUpload(dto))),
    uploadWithDedupInfo: jest.fn(
      async (_ctx: unknown, dto: { buffer?: Buffer; path?: string; filename?: string }) => {
        const hash = sha256(readUpload(dto));
        const existing = stored.get(hash);

        if (existing) {
          return { file: { id: existing }, deduped: true };
        }

        const id = `file-${nextId++}`;
        stored.set(hash, id);

        return { file: { id }, deduped: false };
      },
    ),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BulkFilesController],
      providers: [{ provide: FileService, useValue: fileService }],
    })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useClass(MockJwtAuthGuard)
      .compile();

    app = module.createNestApplication();

    app.use((req: Request, res: Response, next: NextFunction) => {
      ContextService.run({ traceId: 'test-trace-id', userId: 'test-user-id' }, () => next());
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanActivate.mockImplementation(() => true);
    stored.clear();
    nextId = 1;
  });

  it('returns one entry per INPUT file, in input order, mapping in-batch duplicates to one id', async () => {
    const contentX = Buffer.from('content X');
    const contentY = Buffer.from('content Y');

    const res = await request(app.getHttpServer())
      .post('/v1/files')
      .attach('files', contentX, 'a.txt')
      .attach('files', contentY, 'b.txt')
      .attach('files', contentX, 'c-same-as-a.txt')
      .expect(201);

    expect(res.body).toEqual([
      { filename: 'a.txt', sha256: sha256(contentX), id: 'file-1', deduped: false },
      { filename: 'b.txt', sha256: sha256(contentY), id: 'file-2', deduped: false },
      // Same bytes as a.txt: same id, flagged deduped, NOT re-uploaded.
      { filename: 'c-same-as-a.txt', sha256: sha256(contentX), id: 'file-1', deduped: true },
    ]);
    expect(fileService.uploadWithDedupInfo).toHaveBeenCalledTimes(2);
  });

  it('flags server-side (cross-request) duplicates as deduped with the existing id', async () => {
    const content = Buffer.from('already stored');

    await request(app.getHttpServer()).post('/v1/files').attach('files', content, 'first.txt').expect(201);

    const res = await request(app.getHttpServer())
      .post('/v1/files')
      .attach('files', content, 'second.txt')
      .expect(201);

    expect(res.body).toEqual([
      { filename: 'second.txt', sha256: sha256(content), id: 'file-1', deduped: true },
    ]);
  });

  it('passes skipDescription/inventoryCapture form fields through to the upload pipeline', async () => {
    await request(app.getHttpServer())
      .post('/v1/files')
      .field('skipDescription', 'true')
      .field('inventoryCapture', 'true')
      .attach('files', Buffer.from('flagged'), 'flagged.txt')
      .expect(201);

    const dto = fileService.uploadWithDedupInfo.mock.calls[0][1] as {
      skipDescription: boolean;
      inventoryCapture: boolean;
    };
    expect(dto.skipDescription).toBe(true);
    expect(dto.inventoryCapture).toBe(true);
  });

  it('rejects a request over the 50-file cap with a 400', async () => {
    let req = request(app.getHttpServer()).post('/v1/files');

    for (let i = 0; i < 51; i++) {
      req = req.attach('files', Buffer.from(`file ${i}`), `f-${i}.txt`);
    }

    await req.expect(400);
    expect(fileService.uploadWithDedupInfo).not.toHaveBeenCalled();
  });

  it('rejects an empty request with a 400', async () => {
    await request(app.getHttpServer()).post('/v1/files').expect(400);
  });

  it('401s without valid auth', async () => {
    mockCanActivate.mockImplementation(() => {
      throw new UnauthorizedException();
    });

    await request(app.getHttpServer())
      .post('/v1/files')
      .attach('files', Buffer.from('nope'), 'nope.txt')
      .expect(401);

    expect(fileService.uploadWithDedupInfo).not.toHaveBeenCalled();
  });
});
