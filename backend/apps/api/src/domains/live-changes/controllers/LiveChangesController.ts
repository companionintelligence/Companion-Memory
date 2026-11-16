import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { decodeJwt } from 'jose';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { READ_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { extractBearerToken } from '@ci/common/guards/bearerToken';
import type { GuardedRequest } from '@ci/common/guards/guardRequest';

import {
  type LiveChangesCredential,
  type LiveChangeTopic,
  LiveChangesService,
} from '../services/LiveChangesService';

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

/** setTimeout's limit; a longer wait would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * What the request that opens a stream signed in with and when that runs out.
 * The guard has already verified the token, so it is only decoded here. A
 * Portal token's `sid` names a Portal session, not one of ours, so only our
 * own access tokens are tied to a session.
 */
export function streamCredentialOf(req: GuardedRequest): {
  credential: LiveChangesCredential;
  expiresAt: number | null;
} {
  if (req.apiKeyId) {
    return { credential: { kind: 'apiKey', keyId: req.apiKeyId }, expiresAt: null };
  }

  const token = extractBearerToken(req.headers?.authorization);
  let claims: { exp?: unknown; sid?: unknown } = {};

  try {
    claims = token ? decodeJwt(token) : {};
  } catch {
    // Not a JWT: nothing to time or look up.
  }

  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : null;

  if (!req.portalPrincipal && typeof claims.sid === 'string' && claims.sid) {
    return { credential: { kind: 'session', sessionId: claims.sid }, expiresAt };
  }

  return { credential: { kind: 'token' }, expiresAt };
}

/**
 * `GET /live/changes` — a server-sent events stream of "something you can see
 * has changed" hints, one topic name per frame, for the signed-in user.
 *
 * Same plumbing as `OllamaController.stream`: headers that defeat every
 * buffer between here and the browser, a response the socket keeps until the
 * client leaves. The service worker is told not to intercept this path for
 * the reason that applies to every stream (see `vite.config.ts`).
 *
 * ═══ WHEN THE SERVER ENDS IT ═══
 *
 * The guard checks the caller once, when the stream opens. The stream then
 * outlives whatever let it in unless it is ended, so it is:
 *
 * - when the access token it was opened with expires. The web app has a newer
 *   one by then and reconnects with it, one reconnect per token lifetime.
 * - when the api key that opened it is revoked or expires, or the session the
 *   access token was minted for is signed out (Sign out, Sign out everywhere,
 *   a password change). A revoke notice makes every open stream of that user
 *   check at once; each keep-alive checks again, which covers a notice that
 *   never arrived and the paths that send none.
 *
 * A stream asked for with a key or a session that is already gone is refused
 * with 401, the answer the client waits on, so a closed stream does not come
 * straight back.
 */
@Controller('live')
export class LiveChangesController {
  constructor(private readonly liveChanges: LiveChangesService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireCapability(READ_CAPABILITY)
  @Get('changes')
  async changes(
    @Context() context: RequestContext,
    @Req() req: GuardedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const { userId } = toServiceContext(context);

    if (typeof userId !== 'string') {
      res.status(401).end();

      return;
    }

    const { credential, expiresAt } = streamCredentialOf(req);

    // The guard has checked the key, or the token's signature and expiry. It
    // has not checked the session behind a bearer, so the token of a session
    // that was signed out would reopen the stream the moment it was closed.
    if (credential.kind === 'session' && !(await this.liveChanges.isCredentialLive(userId, credential))) {
      res.status(401).end();

      return;
    }

    // A client that left during the guard or the lookup above has already had
    // its `close`. The listeners below would never hear one. Without this
    // the keep-alive and its lookups ran on until the token expired, or for
    // good on a key.
    if (req.destroyed || res.destroyed) {
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

    let checking = false;
    let askedAgain = false;

    // Ends the stream if what opened it no longer lets it in. A notice that
    // lands while a check is out asks again once that check is back: the check
    // may have read before the revoke was written. A failed lookup keeps the
    // stream (the service logs it). The next keep-alive asks again.
    const recheck = async () => {
      if (res.writableEnded) {
        return;
      }

      if (checking) {
        askedAgain = true;

        return;
      }

      checking = true;

      try {
        do {
          askedAgain = false;

          if (!(await this.liveChanges.isCredentialLive(userId, credential))) {
            close();

            return;
          }
        } while (askedAgain && !res.writableEnded);
      } catch {
        // A database hiccup is not a revoke.
      } finally {
        checking = false;
      }
    };

    const unsubscribeRevocations = this.liveChanges.subscribeRevocations(userId, () => void recheck());

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n');
        void recheck();
      }
    }, HEARTBEAT_MS);

    const expiry =
      expiresAt === null
        ? null
        : setTimeout(() => close(), Math.min(Math.max(expiresAt - Date.now(), 0), MAX_TIMER_MS));

    const close = () => {
      clearInterval(heartbeat);

      if (expiry) {
        clearTimeout(expiry);
      }

      for (const timer of pending.values()) {
        clearTimeout(timer);
      }

      pending.clear();
      unsubscribe();
      unsubscribeRevocations();

      if (!res.writableEnded) {
        res.end();
      }
    };

    req.on('close', close);
    res.on('close', close);
  }
}
