import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { AdminOnlyGuard, JwtOrPortalAuthGuard } from '@ci/common/guards';

import type { ToolInvocationEntity } from '../entities/ToolInvocationEntity';
import { TOOL_INVOCATION_OUTCOMES, type ToolInvocationOutcome } from '../events';
import {
  ToolInvocationLedgerService,
  type ToolInvocationQuery,
} from '../services/ToolInvocationLedgerService';

/**
 * The reader over `ci.tool_invocations` — what makes the ledger a ledger rather than another
 * write-only table.
 *
 * Session/JWT (or portal bearer) only, never an api key. The ledger's whole subject is which key
 * called what, so letting a key page through its own record is the one authority it should not
 * have.
 *
 * Two routes because the scope is genuinely two things and both guards should be static:
 *  - `GET /api/tools/invocations` — the caller's OWN invocations. No admin needed; a user asking
 *    what the agent did on their behalf is asking about their own account.
 *  - `GET /api/tools/invocations/system` — invocations with no account at all (background jobs,
 *    crons, the appliance acting as itself). They belong to nobody, so no user-scoped route can
 *    ever return them, and they are the operator's view rather than anyone's personal record —
 *    hence {@link AdminOnlyGuard}.
 *
 * Rows carry no request or response bodies (see the table's migration), so neither route can
 * disclose the user's content — only which capability ran, when, and how it ended.
 */
// Mounted without the `api/` prefix its public URL carries: the gateway strips
// `/api` before forwarding (nginx.conf `location /api/`), so a controller that
// bakes it in never matches. See CI-Server#1684 and
// common/__tests__/controllerGatewayPrefix.test.ts.
@Controller('tools')
export class ToolInvocationsController {
  constructor(private readonly ledger: ToolInvocationLedgerService) {}

  @UseGuards(JwtOrPortalAuthGuard)
  @Get('invocations')
  async listMine(
    @Context() context: RequestContext,
    @Query('tool') tool?: string,
    @Query('outcome') outcome?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<ToolInvocationEntity[]> {
    const { userId } = toServiceContext(context);

    return this.ledger.listForUser(userId, parseInvocationQuery({ tool, outcome, since, limit }));
  }

  @UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)
  @Get('invocations/system')
  async listSystem(
    @Query('tool') tool?: string,
    @Query('outcome') outcome?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<ToolInvocationEntity[]> {
    return this.ledger.listSystem(parseInvocationQuery({ tool, outcome, since, limit }));
  }
}

/**
 * Validate the filters rather than ignoring what is not understood.
 *
 * A misspelled `?outcome=refuse` that were silently dropped would answer "nothing was refused"
 * with a full page of successes — the wrong answer to the one question this endpoint exists to
 * answer.
 */
export function parseInvocationQuery(raw: {
  tool?: string;
  outcome?: string;
  since?: string;
  limit?: string;
}): ToolInvocationQuery {
  const query: ToolInvocationQuery = {};

  if (raw.tool != null && raw.tool !== '') {
    query.tool = raw.tool;
  }

  if (raw.outcome != null && raw.outcome !== '') {
    if (!(TOOL_INVOCATION_OUTCOMES as readonly string[]).includes(raw.outcome)) {
      throw new BadRequestException(
        `Unknown outcome: ${raw.outcome}. Expected one of: ${TOOL_INVOCATION_OUTCOMES.join(', ')}`,
      );
    }

    query.outcome = raw.outcome as ToolInvocationOutcome;
  }

  if (raw.since != null && raw.since !== '') {
    const since = new Date(raw.since);

    if (Number.isNaN(since.getTime())) {
      throw new BadRequestException(`Invalid since: ${raw.since}. Expected an ISO-8601 instant.`);
    }

    query.since = since;
  }

  if (raw.limit != null && raw.limit !== '') {
    const limit = Number(raw.limit);

    if (!Number.isFinite(limit) || limit <= 0) {
      throw new BadRequestException(`Invalid limit: ${raw.limit}. Expected a positive integer.`);
    }

    query.limit = limit;
  }

  return query;
}
