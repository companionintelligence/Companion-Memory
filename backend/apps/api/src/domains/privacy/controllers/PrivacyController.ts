import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod/v3';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FULL_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { type ApiKeyScopedRequest, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import { isManagedAppPrincipal } from '@ci/domains/auth';
import { LastAdminDeletionRefused, UserService } from '@ci/domains/user';

import { type AccountDeletionResult, DataDeletionService } from '../services/DataDeletionService';

/**
 * Full account deletion asks the caller to retype the account's email, the same
 * proof `DELETE /account` asks for. It used to accept a bare `{ confirm: true }`,
 * which proves nobody posted an empty body by accident and nothing else: any
 * credential that could reach the route could send it.
 */
const deleteAccountSchema = z.object({
  confirmEmail: z.string().min(1, 'Account deletion requires the account email in "confirmEmail"'),
  /**
   * Who becomes administrator, by the address they sign in with. Required only when the caller is
   * the appliance's last live administrator and other people still have accounts, exactly as on
   * `DELETE /account`.
   */
  successorEmail: z.string().trim().min(1).optional(),
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
// Mounted without the `api/` prefix its public URL carries: the gateway strips
// `/api` before forwarding (nginx.conf `location /api/`), so a controller that
// bakes it in never matches. See CI-Server#1684 and
// common/__tests__/controllerGatewayPrefix.test.ts.
@Controller('users/me')
export class PrivacyController {
  constructor(
    private readonly dataDeletionService: DataDeletionService,
    private readonly userService: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PrivacyController.name);
  }

  /**
   * Held to the same floor as `DELETE /account`, because it does strictly more:
   * that route revokes access and purges after a grace period an operator can
   * still undo, while this one revokes every OAuth grant and purges at once.
   *
   * - `full`, not the `write` a POST gets by shape. `write` is "nothing that
   *   deletes", and it is the level every new key gets by default, so a key the
   *   owner handed to a script or an agent could end the account here.
   * - An installed app's key is refused even at `full`: ending the account is the
   *   owner's act, and this route has no approval card to raise.
   * - The caller retypes the account's email, case- and whitespace-insensitive.
   *
   * Kept as an immediate delete rather than routed through
   * `UserService.requestDeletion`: this is the user-data-deletion request that
   * also revokes third-party OAuth grants on the spot, which the grace-period
   * path does not do. No first-party client calls it; the web and mobile apps
   * use `DELETE /account`.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireCapability(FULL_CAPABILITY)
  @Post('delete')
  @HttpCode(200)
  async deleteMyAccount(
    @Context() context: RequestContext,
    @Req() req: ApiKeyScopedRequest,
    @Body(new ValidationPipe(deleteAccountSchema)) body: { confirmEmail: string; successorEmail?: string },
  ) {
    if (isManagedAppPrincipal({ managedBy: req.apiKeyManagedBy })) {
      throw new ForbiddenException(
        "An installed app cannot delete this account. That is the owner's decision",
      );
    }

    const serviceContext = toServiceContext(context);
    const user = await this.userService.findById(serviceContext, serviceContext.userId);

    if (!user) {
      throw new BadRequestException('Account not found');
    }

    if (body.confirmEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
      throw new BadRequestException('Confirmation email does not match this account');
    }

    // Before anything is purged: the appliance's last administrator does not leave the other
    // people on it without one, whichever route deletes the account (`DELETE /account` applies
    // the same rule). 409 `SUCCESSOR_REQUIRED` or `SUCCESSOR_NOT_FOUND`, and nothing deleted.
    // The purge runs inside the handover's transaction, so if it fails the successor is not
    // left an administrator beside the caller.
    let result: AccountDeletionResult;

    try {
      result = await this.userService.handOverAdministration(
        serviceContext,
        serviceContext.userId,
        { successorEmail: body.successorEmail },
        () => this.dataDeletionService.deleteAccount(serviceContext),
      );
    } catch (error) {
      throw error instanceof LastAdminDeletionRefused ? error.toConflict() : error;
    }

    return {
      status: 'deleted',
      userDeleted: result.userDeleted,
      totalDeleted: result.totalDeleted,
      deletedCounts: result.deletedCounts,
      deletedObjects: result.deletedObjects,
      connectionsRevoked: result.revocations.filter((r) => r.tokenRevoked).length,
      connectionsProcessed: result.revocations.length,
      auditId: result.auditId,
    };
  }
}
