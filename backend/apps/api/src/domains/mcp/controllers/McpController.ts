import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Controller, Delete, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';

import { McpServerService } from '../services/McpServerService';

@Controller('mcp')
@UseGuards(JwtOrApiKeyAuthGuard)
export class McpController {
  private transports = new Map<string, StreamableHTTPServerTransport>();

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
  async handlePost(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId) {
      transport = this.transports.get(sessionId);

      if (!transport) {
        res.status(404).json({ error: 'Session not found' });

        return;
      }
    } else if (this.isInitializeBody(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const server = this.mcpServerService.getServer();
      await server.connect(transport);

      const newSessionId = transport.sessionId;

      if (newSessionId) {
        this.transports.set(newSessionId, transport);
        this.logger.log('MCP session created', { sessionId: newSessionId });
      }

      transport.onclose = () => {
        if (newSessionId) {
          this.transports.delete(newSessionId);
          this.logger.log('MCP session closed', { sessionId: newSessionId });
        }
      };
    } else {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header. Send an initialize request first.' });

      return;
    }

    await transport.handleRequest(req, res, req.body);
  }

  /**
   * GET /mcp – opens an SSE stream for server-initiated notifications.
   * The client must include the Mcp-Session-Id header from a prior initialize.
   */
  @Get()
  async handleGet(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header' });

      return;
    }

    const transport = this.transports.get(sessionId);

    if (!transport) {
      res.status(404).json({ error: 'Session not found' });

      return;
    }

    await transport.handleRequest(req, res);
  }

  /**
   * DELETE /mcp – terminates the session and cleans up the transport.
   */
  @Delete()
  async handleDelete(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header' });

      return;
    }

    const transport = this.transports.get(sessionId);

    if (!transport) {
      res.status(404).json({ error: 'Session not found' });

      return;
    }

    await transport.close();
    this.transports.delete(sessionId);

    this.logger.log('MCP session terminated by client', { sessionId });

    res.status(200).json({ success: true });
  }

  private isInitializeBody(body: unknown): boolean {
    if (Array.isArray(body)) {
      return body.some((msg) => isInitializeRequest(msg));
    }

    return isInitializeRequest(body);
  }
}
