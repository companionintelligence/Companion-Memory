import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ReadableStream } from 'node:stream/web';

import { Injectable, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

type FetchInit = RequestInit & { duplex?: 'half' };

@Injectable()
export class ProxyService {
  async proxyRequest(req: Request, res: Response, targetUrlString: string): Promise<void> {
    const abortController = new AbortController();

    const abort = () => abortController.abort();

    res.on('close', abort);
    req.on('aborted', abort);

    try {
      const headers = this.prepareProxyHeaders(req);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const body = hasBody ? (Readable.toWeb(req) as unknown as BodyInit) : undefined;

      const upstreamResponse = await fetch(targetUrlString, {
        method: req.method,
        headers,
        signal: abortController.signal,
        body,
        duplex: hasBody ? 'half' : undefined,
      } as FetchInit);

      res.statusCode = upstreamResponse.status;

      upstreamResponse.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie') {
          res.setHeader(key, value);
        }
      });

      const getSetCookie = upstreamResponse.headers.getSetCookie();

      if (getSetCookie.length > 0) {
        res.setHeader('set-cookie', getSetCookie);
      } else {
        const singleCookie = upstreamResponse.headers.get('set-cookie');

        if (singleCookie) {
          res.setHeader('set-cookie', singleCookie);
        }
      }

      if (upstreamResponse.body) {
        const nodeReadable = Readable.fromWeb(upstreamResponse.body as unknown as ReadableStream);

        await pipeline(nodeReadable, res, {
          signal: abortController.signal,
        });
      } else {
        res.end();
      }
    } catch (err: unknown) {
      if (!res.headersSent) {
        const status =
          (err as Error)?.name === 'AbortError' ? HttpStatus.GATEWAY_TIMEOUT : HttpStatus.BAD_GATEWAY;

        res.sendStatus(status);
      }
    } finally {
      res.off('close', abort);
      req.off('aborted', abort);
    }
  }

  private prepareProxyHeaders(req: Request): Headers {
    const headers = new Headers();

    for (const [name, value] of Object.entries(req.headers)) {
      if (!value) {
        continue;
      }

      if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const iter of value) {
          headers.append(name, iter);
        }
      } else {
        headers.set(name, value);
      }
    }

    // X-Forwarded-For (append)
    const inboundXFF = headers.get('x-forwarded-for');
    const clientIp = req.ip ?? req.socket.remoteAddress ?? '';
    const newXff = inboundXFF ? `${inboundXFF}, ${clientIp}` : clientIp;

    if (newXff) {
      headers.set('x-forwarded-for', newXff);
    }

    // X-Forwarded-Proto
    const proto = req.protocol || (req.secure ? 'https' : 'http');

    headers.set('x-forwarded-proto', proto);

    // X-Forwarded-Host (original host seen by this proxy)
    const host = req.get('host');

    if (host) {
      headers.set('x-forwarded-host', host);
    }

    // Let fetch compute content-length
    headers.delete('content-length');

    // Ensure we don't forward a stale Host header
    headers.delete('host');

    return headers;
  }
}
