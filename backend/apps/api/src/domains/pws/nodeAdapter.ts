/**
 * `node:http` binding for the PWS handler: reads the request into a `PwsRequest`, writes the
 * `PwsResponse` back. It exists for the conformance run and for tests that want a real socket; a
 * Nest controller would bind the same handler the same way.
 *
 * Two things are deliberate:
 *
 *   - the request URL is the handler's configured origin plus the raw request target, never the
 *     `Host` header, because a capability's invocation target is compared with the URL as a string;
 *   - the body is capped while it is read. A client that sends more than `maxBodyBytes` gets a
 *     `413 payload-too-large` problem and the connection is closed, without the body ever being
 *     held in memory.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PwsHandler } from './handler';
import { jsonResponse } from './http';
import type { PwsResponse } from './http';
import { PwsError } from './problems';

export interface NodeListenerOptions {
  /** Largest request body read; keep it above the handler's `maxUploadBytes`. */
  maxBodyBytes: number;
}

/** The raw request target as a path and query, even when a client sent absolute-form. */
function pathAndQuery(target: string | undefined): string {
  const raw = target ?? '/';
  if (raw.startsWith('/')) {
    return raw;
  }
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}

/** A problem of the adapter's own, with the headers every other response carries. */
function problemResponse(
  handler: PwsHandler,
  method: string,
  error: PwsError,
  extra: Record<string, string> = {},
) {
  return handler.decorate(
    method,
    jsonResponse(error.status, error.toProblem(), extra, 'application/problem+json'),
  );
}

function write(res: ServerResponse, response: PwsResponse): void {
  res.writeHead(response.status, response.headers);
  res.end(response.body ? Buffer.from(response.body) : undefined);
}

export function nodeListener(
  handler: PwsHandler,
  options: NodeListenerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;

    req.on('data', (chunk: Buffer) => {
      if (refused) {
        return;
      }
      size += chunk.length;
      if (size > options.maxBodyBytes) {
        refused = true;
        write(
          res,
          problemResponse(
            handler,
            req.method ?? 'GET',
            new PwsError('payload-too-large', 'The request body is too large.'),
            {
              connection: 'close',
            },
          ),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (refused) {
        return;
      }
      handler
        .handle({
          method: req.method ?? 'GET',
          url: `${handler.urls.origin}${pathAndQuery(req.url)}`,
          headers: req.headers,
          body: Buffer.concat(chunks),
        })
        .then((response) => write(res, response))
        .catch(() =>
          write(
            res,
            problemResponse(
              handler,
              req.method ?? 'GET',
              new PwsError('internal-error', 'The request could not be completed.'),
            ),
          ),
        );
    });

    req.on('error', () => {
      res.destroy();
    });
  };
}
