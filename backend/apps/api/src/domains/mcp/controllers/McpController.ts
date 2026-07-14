import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { Context, type RequestContext } from '@ci/common/context';
import { MCP_SCOPE, RequireScopes } from '@ci/common/decorators';
import { type ApiKeyScopedRequest, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';

import { McpServerService } from '../services/McpServerService';

/** How long a session can be idle before it is reaped (ms). */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  userId: string;
  /** The authority the session was built for — see {@link apiKeyAuthoritySignature}. */
  authoritySignature: string;
}

/**
 * A stable identity for the caller's api-key authority.
 *
 * The MCP server — its tool list AND every tool handler's captured request — is
 * built once, at `initialize`. A session is therefore frozen to the authority of
 * whoever opened it. Matching on `userId` alone is not enough: on a single-owner
 * appliance the owner's browser session (full authority) and an agent's
 * scope-limited connect key are the SAME user, so the agent could present the
 * owner's `Mcp-Session-Id` and inherit a transport whose GraphQL tools were
 * registered for a full-authority principal — with the handlers' captured request
 * carrying that authority into the resolvers.
 *
 * Keyed on the KEY ID, not just its scopes: both chat agents' connect keys hold an
 * identical scope set under the same owner, so a scopes-only signature would let
 * CI-OpenClaw resume, drive, or terminate CI-Hermes's session. Scopes stay in the
 * signature so that re-scoping a key also retires the sessions it opened.
 *
 * JSON-encoded rather than delimiter-joined: scope strings are free-form, so a naive
 * `join(',')` collides `['a,b']` with `['a','b']` — two different authorities, one
 * signature.
 */
function apiKeyAuthoritySignature(req: ApiKeyScopedRequest): string {
  const scopes = req.apiKeyScopes;

  // Distinct sentinel: a session/JWT principal is not the same authority as an
  // empty-scope (legacy full-access) key, even though both carry full authority.
  if (scopes === undefined) {
    return JSON.stringify({ principal: 'non-api-key' });
  }

  return JSON.stringify({ keyId: req.apiKeyId ?? null, scopes: [...scopes].sort() });
}

// Scope-limited connect keys need the `mcp` scope to reach MCP (CI-Hermes's key
// carries it); session/JWT and empty-scope keys are unaffected.
@Controller('mcp')
@UseGuards(JwtOrApiKeyAuthGuard)
@RequireScopes(MCP_SCOPE)
export class McpController {
  private sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly mcpServerService: McpServerService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext('McpController');
  }

  /**
   * POST /mcp – handles all JSON-RPC messages (initialize, tool calls, etc.).
   * On initialize, a new transport + session is created.
   * Subsequent requests must include the Mcp-Session-Id header.
   */
  @Post()
  async handlePost(@Context() context: RequestContext, @Req() req: Request, @Res() res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId) {
      const entry = this.resolveSession(sessionId, context, req);

      transport = entry.transport;
      entry.lastActivity = Date.now();
    } else if (this.isInitializeBody(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => uuidv4(),
      });

      const server = this.mcpServerService.createServer(req);

      await server.connect(transport);

      transport.onclose = () => {
        const sid = transport?.sessionId;

        if (sid) {
          this.sessions.delete(sid);

          this.logger.log('MCP session closed', {
            sessionId: sid,
          });
        }
      };
    } else {
      res.status(400).json({
        error: 'Missing Mcp-Session-Id header. Send an initialize request first.',
      });

      return;
    }

    await transport.handleRequest(req, res, req.body);

    // After handling an initialize request, the transport now has its sessionId assigned
    if (!sessionId && transport.sessionId) {
      const userId = context.userId ?? 'unknown';

      this.sessions.set(transport.sessionId, {
        transport,
        lastActivity: Date.now(),
        userId,
        authoritySignature: apiKeyAuthoritySignature(req),
      });

      this.logger.log('MCP session created', {
        sessionId: transport.sessionId,
        userId,
      });
    }
  }

  /**
   * GET /mcp – opens an SSE stream for server-initiated notifications.
   * The client must include the Mcp-Session-Id header from a prior initialize.
   */
  @Get()
  async handleGet(@Context() context: RequestContext, @Req() req: Request, @Res() res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header' });

      return;
    }

    const entry = this.resolveSession(sessionId, context, req);

    entry.lastActivity = Date.now();

    await entry.transport.handleRequest(req, res);
  }

  /**
   * DELETE /mcp – terminates the session and cleans up the transport.
   */
  @Delete()
  async handleDelete(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Headers('mcp-session-id') sessionId: string | undefined,
  ) {
    if (!sessionId) {
      throw new BadRequestException('Missing Mcp-Session-Id header');
    }

    const entry = this.resolveSession(sessionId, context, req);

    await entry.transport.close();
    this.sessions.delete(sessionId);

    this.logger.log('MCP session terminated by client', { sessionId });

    return { success: true };
  }

  /**
   * The session named by `sessionId`, if this caller is the one that opened it.
   *
   * The single authority check for every verb, so POST, GET and DELETE cannot drift
   * into disagreeing about who owns a session — one verb accepting a caller the others
   * refuse is exactly the kind of asymmetry that reads as fine in isolation.
   *
   * A caller who is not the opener gets 404, not 403: MCP's Streamable HTTP transport
   * treats 404 as "session is gone, re-initialize" and 401/403 as an auth failure to
   * retry. A key whose scopes were legitimately edited mid-session would otherwise be
   * wedged — unable to resume the old session, unable to DELETE it, and given no signal
   * to open a new one. 404 also declines to confirm that someone else's session id
   * exists.
   */
  private resolveSession(sessionId: string, context: RequestContext, req: Request): SessionEntry {
    const entry = this.sessions.get(sessionId);

    if (
      !entry ||
      entry.userId !== context.userId ||
      entry.authoritySignature !== apiKeyAuthoritySignature(req)
    ) {
      throw new NotFoundException('Session not found');
    }

    return entry;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  private reapStaleSessions() {
    const now = Date.now();

    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        entry.transport.close().catch(() => {});
        this.sessions.delete(sessionId);
        this.logger.log('MCP session reaped (idle timeout)', {
          sessionId,
        });
      }
    }
  }

  private isInitializeBody(body: unknown): boolean {
    if (Array.isArray(body)) {
      return body.some((msg) => isInitializeRequest(msg));
    }

    return isInitializeRequest(body);
  }
}
