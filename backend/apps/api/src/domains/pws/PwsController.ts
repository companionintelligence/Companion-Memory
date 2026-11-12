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
@Controller('pws')
export class PwsController {
  private handler: PwsHandler | null = null;

  private readonly store = new MemoryPwsStore();

  constructor(private readonly features: FeatureService) {}

  @All('*')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!(await this.features.isFeatureEnabled('pws.storage'))) {
      throw new NotFoundException();
    }

    const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol || 'http';
    const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host') || 'localhost';
    const baseUrl = `${proto}://${host}/pws/`;

    if (!this.handler) {
      this.handler = createPwsHandler({
        baseUrl,
        store: this.store,
      });
    }

    const bodyBuf = req.body
      ? Buffer.isBuffer(req.body)
        ? req.body
        : typeof req.body === 'string'
          ? Buffer.from(req.body)
          : Buffer.from(JSON.stringify(req.body))
      : undefined;

    const pwsReq: PwsRequest = {
      method: req.method,
      url: `${proto}://${host}${req.originalUrl || req.url}`,
      headers: req.headers,
      body: bodyBuf ? new Uint8Array(bodyBuf) : undefined,
    };

    const pwsRes = await this.handler.handle(pwsReq);

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
