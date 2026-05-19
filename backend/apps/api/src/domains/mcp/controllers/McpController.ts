import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Optional,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { Context, type RequestContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { AuthDenialLogger } from '@ci/common/scopes';
import config from '@ci/configuration';

import { McpServerService } from '../services/McpServerService';

interface ApiKeyAuthMarker {
  scopes: string[];
  keyId: string;
  actorId: string;
}

/** How long a session can be idle before it is reaped (ms). */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  userId: string;
  cleanup: () => void;
}

@Controller('mcp')
@UseGuards(JwtOrApiKeyAuthGuard)
export class McpController {
  private sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly mcpServerService: McpServerService,
    private readonly logger: LoggerService,
    @Optional() @Inject(AuthDenialLogger) private readonly denialLogger?: AuthDenialLogger,
  ) {
    this.logger.setContext('McpController');
  }

  /**
   * Plan 01 §4.2 — owner-binding. When `config.mcp.ownerUserId` is set, the
   * controller refuses every request whose authenticated `userId` does not
   * match. Records a denial row so the SPA can show the refusal.
   */
  private assertOwnerBinding(req: Request, userId: string | undefined, route: string) {
    const owner = config.mcp.ownerUserId;
    if (!owner) {
      return;
    }

    if (userId !== owner) {
      const apiKeyAuth = (req as { apiKeyAuth?: ApiKeyAuthMarker }).apiKeyAuth;

      this.denialLogger?.record({
        actorId: apiKeyAuth?.actorId ?? userId,
        apiKeyId: apiKeyAuth?.keyId,
        reason: 'owner_mismatch',
        route,
        extra: { boundOwner: owner, callerUserId: userId },
      });

      throw new ForbiddenException({
        error: 'owner_mismatch',
        message: 'MCP is bound to a specific owner and this caller is not it.',
      });
    }
  }

  /**
   * POST /mcp – handles all JSON-RPC messages (initialize, tool calls, etc.).
   * On initialize, a new transport + session is created.
   * Subsequent requests must include the Mcp-Session-Id header.
   */
  @Post()
  async handlePost(@Context() context: RequestContext, @Req() req: Request, @Res() res: Response) {
    this.assertOwnerBinding(req, context.userId, 'POST /mcp');

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport | undefined;
    let pendingCleanup: (() => void) | undefined;

    if (sessionId) {
      const entry = this.sessions.get(sessionId);

      if (!entry) {
        throw new NotFoundException();
      }

      if (entry.userId !== context.userId) {
        throw new UnauthorizedException();
      }

      transport = entry.transport;
      entry.lastActivity = Date.now();
    } else if (this.isInitializeBody(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => uuidv4(),
      });

      const created = this.mcpServerService.createServer(req);

      await created.server.connect(transport);

      // Hold the cleanup closure on the SessionEntry below so resource
      // subscriptions tear down when the transport closes (or is reaped).
      pendingCleanup = created.cleanup;

      transport.onclose = () => {
        const sid = transport?.sessionId;

        if (sid) {
          const removed = this.sessions.get(sid);
          this.sessions.delete(sid);
          removed?.cleanup();

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
        // No-op when this branch did not create a fresh server (shouldn't
        // happen given the !sessionId guard, but keeps the type honest).
        cleanup: pendingCleanup ?? (() => undefined),
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
    this.assertOwnerBinding(req, context.userId, 'GET /mcp');

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header' });

      return;
    }

    const entry = this.sessions.get(sessionId);

    if (!entry) {
      res.status(404).json({ error: 'Session not found' });

      return;
    }

    if (entry.userId !== context.userId) {
      res.status(403).json({ error: 'Session belongs to a different user' });

      return;
    }

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
    this.assertOwnerBinding(req, context.userId, 'DELETE /mcp');

    if (!sessionId) {
      throw new BadRequestException('Missing Mcp-Session-Id header');
    }

    const entry = this.sessions.get(sessionId);

    if (!entry) {
      throw new NotFoundException('Session not found');
    }

    if (entry.userId !== context.userId) {
      throw new ForbiddenException('Session belongs to a different user');
    }

    await entry.transport.close();
    entry.cleanup();
    this.sessions.delete(sessionId);

    this.logger.log('MCP session terminated by client', { sessionId });

    return { success: true };
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  private reapStaleSessions() {
    const now = Date.now();

    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        entry.transport.close().catch(() => {});
        entry.cleanup();
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
