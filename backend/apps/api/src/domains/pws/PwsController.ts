import { All, Controller, NotFoundException, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { FeatureService } from '@ci/common/feature';

import { createPwsHandler } from './handler';
import type { PwsHandler } from './handler';
import type { PwsRequest } from './http';
import { MemoryPwsStore } from './store';

/**
 * Controller for Portable Web Spaces (PWS) storage facade (`/pws/*`).
 * Gated by `pws.storage` feature flag (off by default; returns 404 when disabled).
 */
const SAFE_HOST_PATTERN = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;
const MAX_CACHED_HANDLERS = 32;
const MAX_PWS_BODY_BYTES = 25 * 1024 * 1024;

function readRawRequestBody(req: Request, maxBytes: number): Promise<Buffer | undefined> {
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) {
      return Promise.resolve(req.body);
    }

    if (typeof req.body === 'string') {
      return Promise.resolve(Buffer.from(req.body, 'utf8'));
    }

    return Promise.resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
  }

  if (typeof req.on !== 'function' || req.readableEnded) {
    return Promise.resolve(undefined);
  }

  return new Promise<Buffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    req.on('data', (chunk: Buffer | string) => {
      if (settled) {
        return;
      }

      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        req.pause?.();
        fail(new Error('PWS_PAYLOAD_TOO_LARGE'));

        return;
      }

      chunks.push(buf);
    });

    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(chunks.length > 0 ? Buffer.concat(chunks) : undefined);
      }
    });

    req.on('error', (err: Error) => fail(err));
  });
}

@Controller('pws')
export class PwsController {
  private readonly handlers = new Map<string, PwsHandler>();

  private readonly store = new MemoryPwsStore();

  constructor(private readonly features: FeatureService) {}

  @All(['', '*splat'])
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!(await this.features.isFeatureEnabled('pws.storage'))) {
      throw new NotFoundException();
    }

    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    const proto = forwardedProto === 'https' || req.protocol === 'https' ? 'https' : 'http';
    const rawHost = req.get('host')?.trim() ?? '';
    const host = SAFE_HOST_PATTERN.test(rawHost) ? rawHost : 'localhost';
    const baseUrl = `${proto}://${host}/pws/`;

    let handler = this.handlers.get(baseUrl);
    if (!handler) {
      if (this.handlers.size >= MAX_CACHED_HANDLERS) {
        const oldestKey = this.handlers.keys().next().value;
        if (oldestKey !== undefined) {
          this.handlers.delete(oldestKey);
        }
      }

      handler = createPwsHandler({
        baseUrl,
        store: this.store,
      });
      this.handlers.set(baseUrl, handler);
    }

    let bodyBuf: Buffer | undefined;
    try {
      bodyBuf = await readRawRequestBody(req, MAX_PWS_BODY_BYTES);
    } catch (error) {
      if (error instanceof Error && error.message === 'PWS_PAYLOAD_TOO_LARGE') {
        res.status(413);
        res.end();

        return;
      }

      throw error;
    }

    const pwsReq: PwsRequest = {
      method: req.method,
      url: `${proto}://${host}${req.originalUrl || req.url}`,
      headers: req.headers,
      body: bodyBuf ? new Uint8Array(bodyBuf) : undefined,
    };

    const pwsRes = await handler.handle(pwsReq);

    for (const [key, value] of Object.entries(pwsRes.headers)) {
      res.setHeader(key, value);
    }

    res.status(pwsRes.status);
    if (pwsRes.body) {
      res.end(Buffer.from(pwsRes.body));
    } else {
      res.end();
    }
  }
}
