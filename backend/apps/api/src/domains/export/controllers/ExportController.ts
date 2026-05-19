import { Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { Scopes, ScopesGuard, SCOPES } from '@ci/common/scopes';

import { ExportService } from '../services/ExportService';

/**
 * Plan 11 §3 — data-portability endpoint.
 *
 *  POST /me/export
 *    — Assembles the full user data export and returns it as a JSON
 *      attachment (Content-Disposition: attachment).
 *    — Requires scope `profile:read` (the broadest "read my own data" scope).
 *    — Today synchronous; for large accounts a background-job path will be
 *      added that returns 202 + { jobId } and exposes a polling GET endpoint.
 */
@UseGuards(JwtOrApiKeyAuthGuard, ScopesGuard)
@Controller('me')
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Scopes(SCOPES.PROFILE_READ)
  @Post('export')
  async export(@Context() context: RequestContext, @Res() res: Response) {
    const { userId } = toServiceContext(context);

    const exportData = await this.exportService.buildExport(userId);

    const filename = `ci-export-${userId}-${new Date().toISOString().slice(0, 10)}.json`;
    const body = JSON.stringify(exportData, null, 2);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.status(200).send(body);
  }
}
