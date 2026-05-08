import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Controller, Delete, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Request, Response } from 'express';

import { Context, type RequestContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';

import { McpServerService } from '../services/McpServerService';

/** How long a session can be idle before it is reaped (ms). */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  userId: string;
}

@Controller('mcp')
@UseGuards(JwtOrApiKeyAuthGuard)
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
      const entry = this.sessions.get(sessionId);

      if (!entry) {
        res.status(404).json({ error: 'Session not found' });

        return;
      }

      if (entry.userId !== context.userId) {
        res.status(403).json({ error: 'Session belongs to a different user' });

        return;
      }

      transport = entry.transport;
      entry.lastActivity = Date.now();
    } else if (this.isInitializeBody(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const server = this.mcpServerService.createServer(req);
      await server.connect(transport);

      transport.onclose = () => {
        const sid = transport?.sessionId;

        if (sid) {
          this.sessions.delete(sid);
          this.logger.log('MCP session closed', { sessionId: sid });
        }
      };
    } else {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header. Send an initialize request first.' });

      return;
    }

    await transport.handleRequest(req, res, req.body);

    // After handling an initialize request, the transport now has its sessionId assigned
    if (!sessionId && transport.sessionId) {
      const userId = context.userId ?? 'unknown';
      this.sessions.set(transport.sessionId, { transport, lastActivity: Date.now(), userId });
      this.logger.log('MCP session created', { sessionId: transport.sessionId, userId });
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
  async handleDelete(@Context() context: RequestContext, @Req() req: Request, @Res() res: Response) {
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

    await entry.transport.close();
    this.sessions.delete(sessionId);

    this.logger.log('MCP session terminated by client', { sessionId });

    res.status(200).json({ success: true });
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  private reapStaleSessions() {
    const now = Date.now();

    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        entry.transport.close().catch(() => {});
        this.sessions.delete(sessionId);
        this.logger.log('MCP session reaped (idle timeout)', { sessionId });
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
