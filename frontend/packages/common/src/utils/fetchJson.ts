import { apiKeyHeaders } from './apiAuth';
import { buildApiUrl } from './apiBase';

interface Opts extends RequestInit {
  timeout?: number;
  /**
   * Suppress the automatic `x-api-key` header. Set it for requests that are NOT going to
   * the configured CI-Server appliance — today that means the on-device Local Hub sidecar
   * (`localHub.ts` / `outbox.ts`), which is a different origin with its own bearer token.
   * Two reasons, both real: the appliance API key has no business being sent to another
   * server, and the sidecar's CORS policy allowlists a fixed set of request headers — an
   * unexpected `x-api-key` fails the WebView's preflight and the request never goes out.
   */
  skipApiKey?: boolean;
}

/**
 * Field-level validation issue reported by the API. Mirrors the zod issue
 * shape the backend ValidationPipe puts in the `errors` array of 400 bodies,
 * so forms can attach server-side messages to the offending field.
 */
export interface FetchJsonIssue {
  path?: Array<string | number>;
  message?: string;
}

/**
 * Error thrown by {@link fetchJson} for non-2xx responses. Carries the HTTP
 * status so callers can branch on it (e.g. useAuth retries a refresh exactly
 * once on 403 — a stale CSRF token — but never on 401, which means the session
 * itself is invalid). When the response body is JSON, `message` is the
 * server's message and `issues` holds any field-level validation errors, so
 * the backend stays the single source of truth for validation rules.
 */
export class FetchJsonError extends Error {
  readonly status: number;

  readonly issues: FetchJsonIssue[];

  constructor(status: number, statusText: string, serverMessage?: string, issues: FetchJsonIssue[] = []) {
    super(serverMessage || `Fetch failed: ${status} ${statusText}`);
    this.name = 'FetchJsonError';
    this.status = status;
    this.issues = issues;
  }
}

// A stalled error body must not hang callers: the request timeout (if any) was
// already cleared when headers arrived, and before body parsing existed the
// error path threw at headers without reading the body — so the read gets its
// own hard bound.
const ERROR_BODY_TIMEOUT_MS = 3_000;

// Normalize a wire entry to the declared shape: only plain objects count, and
// path/message are kept only when their runtime types match.
function toIssue(entry: unknown): FetchJsonIssue[] {
  if (typeof entry !== 'object' || entry == null || Array.isArray(entry)) {
    return [];
  }

  const { path, message } = entry as { path?: unknown; message?: unknown };

  return [
    {
      path: Array.isArray(path)
        ? path.filter(
            (segment): segment is string | number =>
              typeof segment === 'string' || typeof segment === 'number',
          )
        : undefined,
      message: typeof message === 'string' ? message : undefined,
    },
  ];
}

/**
 * Read the error body under a hard time bound. The stream is drained through a
 * reader we own so the timeout can cancel it: abandoning a `res.json()` would
 * leave the abandoned read holding the connection for the lifetime of the
 * page, which is the opposite of what the bound is for (and `json()` locks the
 * body, so it cannot be cancelled afterwards).
 */
async function readErrorBody(res: Response): Promise<string | undefined> {
  const stream = res.body;

  if (typeof stream?.getReader !== 'function') {
    // Response-like without a readable stream (some runtimes, test doubles):
    // race text() instead and accept that there is nothing to cancel.
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const text = res.text();
      // A late rejection must not surface as an unhandled rejection once the
      // timer has won the race.
      text.catch(() => undefined);

      return await Promise.race([
        text,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), ERROR_BODY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer != null) {
        clearTimeout(timer);
      }
    }
  }

  const reader = stream.getReader();
  const timer = setTimeout(() => {
    // Best effort: releases the underlying connection. Pending reads settle as
    // done, so the loop below exits with whatever arrived before the bound.
    void reader.cancel().catch(() => undefined);
  }, ERROR_BODY_TIMEOUT_MS);

  try {
    const decoder = new TextDecoder();
    let text = '';

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
  }
}

async function parseErrorBody(res: Response): Promise<{ serverMessage?: string; issues: FetchJsonIssue[] }> {
  try {
    const text = await readErrorBody(res);
    const body: unknown = text ? JSON.parse(text) : undefined;

    if (typeof body !== 'object' || body == null) {
      return { issues: [] };
    }

    const { message, errors, error } = body as { message?: unknown; errors?: unknown; error?: unknown };

    return {
      // NestJS sends `message` as a string (or string[] from some built-in
      // pipes); object payloads thrown with only an `error` key fall back to it.
      serverMessage:
        typeof message === 'string'
          ? message
          : Array.isArray(message)
            ? message.join('; ')
            : typeof error === 'string'
              ? error
              : undefined,
      issues: Array.isArray(errors) ? errors.flatMap(toIssue) : [],
    };
  } catch (err) {
    // A caller-supplied signal aborting mid-read is a cancellation, not a
    // server failure — let it propagate as such. (Name check rather than
    // instanceof: DOMException does not extend Error in every runtime.)
    if (err != null && typeof err === 'object' && (err as Error).name === 'AbortError') {
      throw err;
    }

    // Body wasn't JSON (e.g. a proxy error page) — fall back to the status line
    return { issues: [] };
  }
}

export async function fetchJson<T>(input: RequestInfo, init?: Opts): Promise<T | undefined> {
  const { timeout, skipApiKey, ...rest } = init ?? {};

  // On native, attach the API key (`x-api-key`). No-op on web (returns `{}`), so the
  // request is unchanged. Callers pass plain-object headers, so a shallow merge is
  // safe; the caller's own headers take precedence on the (unused) key collision.
  const keyHeaders = skipApiKey ? {} : apiKeyHeaders();

  if (Object.keys(keyHeaders).length > 0) {
    rest.headers = { ...keyHeaders, ...(rest.headers as Record<string, string> | undefined) };
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  if (timeout != null && rest.signal == null) {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), timeout);
    rest.signal = controller.signal;
  }

  // String paths (e.g. `/api/...`) are resolved against the configured API origin.
  // On web this is a no-op (origin is ''); on native it targets the user's server.
  const resolved = typeof input === 'string' ? buildApiUrl(input) : input;

  // clear in `finally`: if fetch() rejects (network error, DNS failure) before
  // the timeout fires, skipping the clear would leave the timer pending — it
  // would later abort an already-settled request and keep the event loop alive.
  let res: Response;
  try {
    res = await fetch(resolved, rest);
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
  }

  if (!res.ok) {
    const { serverMessage, issues } = await parseErrorBody(res);
    throw new FetchJsonError(res.status, res.statusText, serverMessage, issues);
  }

  const text = await res.text();

  return text ? (JSON.parse(text) as T) : undefined;
}
