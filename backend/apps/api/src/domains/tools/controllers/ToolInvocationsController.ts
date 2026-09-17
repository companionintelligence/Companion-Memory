import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { AdminOnlyGuard, JwtOrPortalAuthGuard } from '@ci/common/guards';

import { TOOL_PRINCIPALS, type ToolPrincipal } from '../core/types';
import { TOOL_INVOCATION_OUTCOMES, type ToolInvocationOutcome } from '../events';
import {
  ToolInvocationLedgerService,
  decodeCursor,
  type ToolInvocationPage,
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
    @Query('principal') principal?: string,
    @Query('app') app?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ToolInvocationPage> {
    const { userId } = toServiceContext(context);

    return this.ledger.listForUser(
      userId,
      parseInvocationQuery({ tool, outcome, since, limit, principal, app, cursor }),
    );
  }

  @UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)
  @Get('invocations/system')
  async listSystem(
    @Query('tool') tool?: string,
    @Query('outcome') outcome?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @Query('principal') principal?: string,
    @Query('app') app?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ToolInvocationPage> {
    return this.ledger.listSystem(
      parseInvocationQuery({ tool, outcome, since, limit, principal, app, cursor }),
    );
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
  principal?: string;
  app?: string;
  cursor?: string;
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

  if (raw.principal != null && raw.principal !== '') {
    if (!(TOOL_PRINCIPALS as readonly string[]).includes(raw.principal)) {
      throw new BadRequestException(
        `Unknown principal: ${raw.principal}. Expected one of: ${TOOL_PRINCIPALS.join(', ')}`,
      );
    }

    query.principal = raw.principal as ToolPrincipal;
  }

  // `app` on the wire, `principalName` in the query: the URL should read the way the question is
  // asked ("what has this app been doing"), and the column name is an implementation detail of
  // storing an api-key name rather than a display one.
  if (raw.app != null && raw.app !== '') {
    query.principalName = raw.app;
  }

  // A cursor this reader cannot decode is a 400, never a silent first page. Paging a ledger is
  // how someone reads back what happened; quietly restarting at the top would report the newest
  // rows over and over as if they were older ones.
  if (raw.cursor != null && raw.cursor !== '') {
    try {
      query.cursor = decodeCursor(raw.cursor);
    } catch {
      throw new BadRequestException(
        `Invalid cursor: ${raw.cursor}. Pass back the \`nextCursor\` from a previous page.`,
      );
    }
  }

  return query;
}
