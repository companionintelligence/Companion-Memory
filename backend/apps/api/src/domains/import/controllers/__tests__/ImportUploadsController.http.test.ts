import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import config from '@ci/configuration';

import { StagedSourceService } from '../../services/StagedSourceService';
import { ImportUploadsController } from '../ImportUploadsController';

/**
 * The upload route through multer, as a browser calls it. A browser writes the
 * file name into the multipart header as raw UTF-8; the name has to reach the
 * disk spelled the way the person named the file, because importers such as
 * WhatsApp's read the chat's name from it.
 */
describe('POST /import/uploads (multipart)', () => {
  let app: INestApplication;
  let uploadsDir: string;
  let previousUploadsDir: string;
  // The controller makes `<uploadsDir>/incoming` when the app starts, so the
  // configured folder points at a temp one before then, not the real one.
  let initUploadsDir: string;
  let configuredUploadsDir: string;

  const sources = {
    registerUpload: jest.fn(async (_ctx: unknown, input: { dropId: string; originalFilename: string }) => ({
      dropId: input.dropId,
      originalFilename: input.originalFilename,
      sizeBytes: null,
      status: 'staged',
      expiresAt: null,
    })),
  };

  beforeAll(async () => {
    initUploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uploads-http-init-'));
    configuredUploadsDir = config.import.uploadsDir;
    (config.import as { uploadsDir: string }).uploadsDir = initUploadsDir;

    const module = await Test.createTestingModule({
      controllers: [ImportUploadsController],
      providers: [{ provide: StagedSourceService, useValue: sources }],
    })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      ContextService.run({ traceId: 'test-trace-id', userId: 'user-1' }, () => next());
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
    (config.import as { uploadsDir: string }).uploadsDir = configuredUploadsDir;
    fs.rmSync(initUploadsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uploads-http-'));
    previousUploadsDir = config.import.uploadsDir;
    (config.import as { uploadsDir: string }).uploadsDir = uploadsDir;
  });

  afterEach(() => {
    (config.import as { uploadsDir: string }).uploadsDir = previousUploadsDir;
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  });

  it('keeps a non-ASCII file name as the browser sent it', async () => {
    const name = 'WhatsApp Chat with José’s Café.txt';

    const res = await request(app.getHttpServer())
      .post('/import/uploads')
      .attach('files', Buffer.from('03/08/2026, 09:14 - José: hola'), {
        filename: name,
        contentType: 'text/plain',
      })
      .expect(201);

    expect(res.body[0].originalFilename).toBe(name);

    const sourcePath = sources.registerUpload.mock.calls[0][1] as unknown as { sourcePath: string };
    expect(path.basename(sourcePath.sourcePath)).toBe(name);
    expect(fs.readFileSync(sourcePath.sourcePath, 'utf8')).toBe('03/08/2026, 09:14 - José: hola');
  });
});
