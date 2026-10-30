import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { READ_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { type LiveChangeTopic, LiveChangesService } from '../services/LiveChangesService';

/**
 * Comment frames every 25 s: short of the 30 s at which browsers and the
 * appliance gateway start to wonder whether a silent stream is dead, and the
 * generic `/api/` location's 300 s read timeout counts from the last byte.
 */
export const HEARTBEAT_MS = 25_000;

/**
 * A burst of writes — an import landing a hundred events, a planner pass
 * touching ten tasks — becomes one frame per topic per window, not a refetch
 * per row. The client debounces too; this keeps the wire quiet.
 */
export const COALESCE_MS = 250;

/** Reconnect delay suggested to the browser (SSE `retry:` field). */
export const RETRY_MS = 3_000;

/**
 * `GET /live/changes` — a server-sent events stream of "something you can see
 * has changed" hints, one topic name per frame, for the signed-in user.
 *
 * Same plumbing as `OllamaController.stream`: headers that defeat every
 * buffer between here and the browser, a response the socket keeps until the
 * client leaves. The service worker is told not to intercept this path for
 * the reason that applies to every stream (see `vite.config.ts`).
 */
@Controller('live')
export class LiveChangesController {
  constructor(private readonly liveChanges: LiveChangesService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireCapability(READ_CAPABILITY)
  @Get('changes')
  changes(@Context() context: RequestContext, @Req() req: Request, @Res() res: Response): void {
    const { userId } = toServiceContext(context);

    if (typeof userId !== 'string') {
      res.status(401).end();

      return;
    }

    res.socket?.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(`retry: ${RETRY_MS}\n: connected\n\n`);

    const pending = new Map<LiveChangeTopic, NodeJS.Timeout>();

    const unsubscribe = this.liveChanges.subscribe(userId, (topic) => {
      if (pending.has(topic) || res.writableEnded) {
        return;
      }

      const timer = setTimeout(() => {
        pending.delete(topic);

        if (!res.writableEnded) {
          res.write(`event: change\ndata: ${JSON.stringify({ topic })}\n\n`);
        }
      }, COALESCE_MS);

      pending.set(topic, timer);
    });

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n');
      }
    }, HEARTBEAT_MS);

    const close = () => {
      clearInterval(heartbeat);

      for (const timer of pending.values()) {
        clearTimeout(timer);
      }

      pending.clear();
      unsubscribe();

      if (!res.writableEnded) {
        res.end();
      }
    };

    req.on('close', close);
    res.on('close', close);
  }
}
