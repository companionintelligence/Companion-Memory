import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { Context, type RequestContext } from '@ci/common/context';
import { INTENTS_SCOPE, READ_CAPABILITY, RequireCapability, RequireScopes } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard, type ApiKeyScopedRequest, apiKeyCapabilityOf } from '@ci/common/guards';
import { isManagedAppPrincipal } from '@ci/domains/auth';

import type { ToolResult } from '../core/types';
import type { PendingAction } from '../entities/PendingActionEntity';
import { PENDING_ACTION_STATUSES, type PendingActionStatus } from '../pendingActionStatus';
import { PendingActionConfirmService } from '../services/PendingActionConfirmService';
import { PendingActionService } from '../services/PendingActionService';

/**
 * The READER of `ci.pending_actions` — the half without which the queue would be
 * another write-only table.
 *
 * `ToolRegistry.executeTool` is the writer; this is where the owner sees what is
 * parked and answers it. Both land together on purpose: a confirmation queue
 * nobody can confirm from is exactly the defect the queue was built to fix.
 *
 * `@RequireCapability(READ_CAPABILITY)` is the HTTP floor so a read-only key can
 * still LIST its queue. It is deliberately not the gate on approval: confirming
 * re-runs `capabilityAllows` against this caller's real capability in
 * {@link PendingActionConfirmService.confirm}, which is what stops the queue
 * being a capability escalator.
 */
/**
 * An approval card is the OWNER's answer. Refuse to take it from an installed app.
 *
 * Both harnesses carry the `intents` scope this controller requires, and
 * approve/decline sit behind `READ_CAPABILITY`, so without this a harness could
 * list the owner's queue and answer its own card.
 *
 * It is not a privilege escalation — `PendingActionConfirmService.confirm`
 * re-runs `capabilityAllows` against the CONFIRMING principal, so an app can
 * only ever approve something it was already allowed to run. It is worse than
 * that in a subtler way: the card exists precisely BECAUSE the caller was an
 * installed app, so letting the app answer it turns the whole gate into a
 * formality it performs on itself.
 *
 * Provenance from `managed_by`, never from the key's name.
 */
function refuseManagedApp(req: ApiKeyScopedRequest, action: string): void {
  if (isManagedAppPrincipal({ managedBy: req.apiKeyManagedBy })) {
    throw new ForbiddenException(
      `An installed app cannot ${action} an approval card — this is the owner's decision to make`,
    );
  }
}

@UseGuards(JwtOrApiKeyAuthGuard)
@RequireScopes(INTENTS_SCOPE)
// Mounted without the `api/` prefix its public URL carries: the gateway strips
// `/api` before forwarding (nginx.conf `location /api/`), so a controller that
// bakes it in never matches. See CI-Server#1684 and
// common/__tests__/controllerGatewayPrefix.test.ts.
@Controller(['pending-actions', 'agent/pending-actions'])
export class PendingActionsController {
  constructor(
    private readonly pending: PendingActionService,
    private readonly confirmations: PendingActionConfirmService,
  ) {}

  /** This user's queue, newest first. `?status=proposed` narrows it. */
  @Get()
  @RequireCapability(READ_CAPABILITY)
  async list(
    @Context() context: RequestContext,
    @Query('status') status?: string,
  ): Promise<{ actions: PendingAction[] }> {
    const userId = requireUserId(context);

    return { actions: await this.pending.list(userId, parseStatus(status)) };
  }

  /**
   * Confirm and run. 403 if THIS caller's capability cannot run the intent —
   * regardless of what the proposing caller's could.
   */
  @Post(':id/approve')
  @HttpCode(200)
  @RequireCapability(READ_CAPABILITY)
  async approve(
    @Param('id') id: string,
    @Context() context: RequestContext,
    @Req() req: ApiKeyScopedRequest,
  ): Promise<{ action: PendingAction; result: ToolResult }> {
    const userId = requireUserId(context);

    refuseManagedApp(req, 'approve');

    return this.confirmations.confirm(userId, id, apiKeyCapabilityOf(req), new Date(), req);
  }

  /** Refuse it. Terminal; the intent never runs. */
  @Post(':id/decline')
  @HttpCode(200)
  @RequireCapability(READ_CAPABILITY)
  async decline(
    @Param('id') id: string,
    @Context() context: RequestContext,
    @Req() req: ApiKeyScopedRequest,
  ): Promise<{ action: PendingAction }> {
    const userId = requireUserId(context);

    // Declining is the owner's answer too. An app that could decline its own
    // card could bury an action the owner never saw.
    refuseManagedApp(req, 'decline');

    return { action: await this.confirmations.decline(userId, id) };
  }
}

/**
 * Every row is owner-scoped, so an unauthenticated context has no queue to
 * read — refuse rather than fall back to some default user.
 */
function requireUserId(context: RequestContext): string {
  if (!context.userId) {
    throw new UnauthorizedException('Pending actions require an authenticated user');
  }

  return context.userId;
}

/**
 * Rejects an unrecognized `status` rather than ignoring it: silently returning
 * the unfiltered queue to a client that asked for one state would read as "there
 * are no proposals" when the list happens to be all-terminal, or the reverse.
 */
function parseStatus(status: string | undefined): PendingActionStatus | undefined {
  if (status == null || status === '') {
    return undefined;
  }

  if (!(PENDING_ACTION_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestException(
      `Unknown pending action status: ${status}. Expected one of: ${PENDING_ACTION_STATUSES.join(', ')}`,
    );
  }

  return status as PendingActionStatus;
}
