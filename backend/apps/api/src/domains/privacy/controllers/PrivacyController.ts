import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';

import { DataDeletionService } from '../services/DataDeletionService';

/**
 * Full account deletion requires an explicit `{ confirm: true }` so it cannot be
 * triggered by an empty/accidental POST — the same guard the destructive
 * maintenance endpoints use.
 */
const deleteAccountSchema = z.object({
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'Account deletion requires "confirm": true' }),
  }),
});

/**
 * Privacy / user-data-deletion endpoints (CASA ASVS V8).
 *
 * POST /api/users/me/delete — delete the authenticated user's account and ALL of
 * their data (every connection revoked, every derived table purged, the user row
 * removed). Owner-scoped by construction: the service only ever operates on the
 * authenticated caller's own userId (from the auth guard), never an id from the
 * request body/params, so there is no cross-user deletion surface.
 */
@Controller('api/users/me')
export class PrivacyController {
  constructor(
    private readonly dataDeletionService: DataDeletionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PrivacyController.name);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('delete')
  @HttpCode(200)
  async deleteMyAccount(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(deleteAccountSchema)) _body: { confirm: true },
  ) {
    // The ValidationPipe enforces confirm:true; the value isn't otherwise used.
    void _body;

    const serviceContext = toServiceContext(context);

    const result = await this.dataDeletionService.deleteAccount(serviceContext);

    return {
      status: 'deleted',
      userDeleted: result.userDeleted,
      totalDeleted: result.totalDeleted,
      deletedCounts: result.deletedCounts,
      connectionsRevoked: result.revocations.filter((r) => r.tokenRevoked).length,
      connectionsProcessed: result.revocations.length,
      auditId: result.auditId,
    };
  }
}
