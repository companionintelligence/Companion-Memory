import { createHash } from 'node:crypto';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface RequesterInput {
  method: HttpMethod;
  url: string;
  query?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * Stable, opaque identifier for the authenticated principal whose credentials
   * are bound to this request (e.g. `RequestSignature.identity` from
   * `authStrategies`, or a hash of the connection's access token; `null` for
   * anonymous). Included in the dedup key so requests with
   * different auth never collide.
   */
  authIdentity?: string | null;
  /** Overrides the Requester's default timeout for this request. */
  timeoutMs?: number;
}

export interface RequesterOptions {
  /** Applied to every request unless overridden per-request. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface RequesterResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

export class RequesterTransportError extends Error {
  constructor(
    public readonly method: HttpMethod,
    public readonly url: string,
    cause: unknown,
  ) {
    super(`Requester transport failure: ${method} ${url}`);
    this.name = 'RequesterTransportError';
    this.cause = cause;
  }
}

export class RequesterTimeoutError extends RequesterTransportError {
  constructor(
    method: HttpMethod,
    url: string,
    public readonly timeoutMs: number,
  ) {
    super(method, url, undefined);
    this.name = 'RequesterTimeoutError';
    this.message = `Requester timeout after ${timeoutMs}ms: ${method} ${url}`;
  }
}

/**
 * Short-lived HTTP client for outbound provider calls.
 *
 * Construct one per unit of work (a sync run, a request handler) and let it go
 * out of scope when that work finishes. Concurrent identical sub-requests
 * issued while it is alive share a single in-flight `fetch` via the internal
 * dedup cache, which is dropped along with the instance — so it never behaves
 * as a long-lived response cache.
 *
 * Non-2xx responses are returned, not thrown — the caller decides whether a
 * status code is a domain error. Only transport-level failures throw, as
 * `RequesterTransportError` (`RequesterTimeoutError` when the deadline hits).
 *
 * Every request runs under a deadline (default 30s) covering both the
 * connection and the body read.
 *
 * TODO: retries and circuit breaking.
 */
export class Requester {
  private readonly inflight = new Map<string, Promise<RequesterResponse>>();

  private readonly defaultTimeoutMs: number;

  constructor(options: RequesterOptions = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request(input: RequesterInput): Promise<RequesterResponse> {
    const url = buildUrl(input.url, input.query);
    const bodyText = serializeBody(input.body);
    const key = cacheKey(input.method, url, bodyText, input.authIdentity ?? null);

    const existing = this.inflight.get(key);

    if (existing != null) {
      return existing;
    }

    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const promise = this.execute(input.method, url, input.headers ?? {}, bodyText, timeoutMs);

    this.inflight.set(key, promise);

    return promise;
  }

  private async execute(
    method: HttpMethod,
    url: string,
    headers: Record<string, string>,
    bodyText: string | undefined,
    timeoutMs: number,
  ): Promise<RequesterResponse> {
    const start = performance.now();
    const signal = AbortSignal.timeout(timeoutMs);

    let response: Response;
    let rawText: string;

    try {
      response = await fetch(url, {
        method,
        headers,
        body: bodyText,
        signal,
      });
      rawText = await response.text();
    } catch (cause) {
      if (signal.aborted) {
        throw new RequesterTimeoutError(method, url, timeoutMs);
      }

      throw new RequesterTransportError(method, url, cause);
    }

    const durationMs = performance.now() - start;
    const contentType = response.headers.get('content-type') ?? '';
    const body = parseBody(rawText, contentType);

    return {
      status: response.status,
      headers: collectHeaders(response.headers),
      body,
      durationMs,
    };
  }
}

function buildUrl(base: string, query: RequesterInput['query']): string {
  if (query == null) {
    return base;
  }

  const url = new URL(base);
  const entries = Object.entries(query).filter(([, value]) => value !== undefined);

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const [name, value] of entries) {
    if (Array.isArray(value)) {
      const sorted = [...value].map(String).sort();

      for (const item of sorted) {
        url.searchParams.append(name, item);
      }
    } else {
      url.searchParams.append(name, String(value));
    }
  }

  return url.toString();
}

function serializeBody(body: unknown): string | undefined {
  if (body == null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body;
  }

  return JSON.stringify(body);
}

function cacheKey(
  method: HttpMethod,
  url: string,
  bodyText: string | undefined,
  authIdentity: string | null,
): string {
  const bodyHash = bodyText == null ? '' : sha1(bodyText);
  const authHash = authIdentity == null ? '' : sha1(authIdentity);

  return `${method}\n${url}\n${bodyHash}\n${authHash}`;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function parseBody(text: string, contentType: string): unknown {
  if (text.length === 0) {
    return null;
  }

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};

  headers.forEach((value, key) => {
    out[key] = value;
  });

  return out;
}
