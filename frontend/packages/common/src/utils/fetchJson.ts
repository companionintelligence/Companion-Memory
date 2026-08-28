import { apiKeyHeaders } from './apiAuth';
import { buildApiUrl, isNativePlatform } from './apiBase';

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

type CapacitorHttpPlugin = {
  request: (opts: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    data?: unknown;
    connectTimeout?: number;
    readTimeout?: number;
    responseType?: 'arraybuffer' | 'blob' | 'json' | 'text';
  }) => Promise<{ status: number; data: unknown; headers?: Record<string, string> }>;
};

function capacitorHttp(): CapacitorHttpPlugin | undefined {
  if (typeof window === 'undefined' || !isNativePlatform()) {
    return undefined;
  }

  const cap = (
    window as unknown as {
      Capacitor?: {
        Plugins?: { CapacitorHttp?: CapacitorHttpPlugin };
        registerPlugin?: (name: string) => CapacitorHttpPlugin;
      };
    }
  ).Capacitor;

  const existing = cap?.Plugins?.CapacitorHttp;

  if (existing?.request) {
    return existing;
  }

  try {
    const registered = cap?.registerPlugin?.('CapacitorHttp');

    if (registered?.request) {
      return registered;
    }
  } catch {
    /* native binary does not expose the plugin */
  }

  return undefined;
}

function flattenHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });

    return out;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

function requestData(body: BodyInit | null | undefined): unknown {
  if (body == null) {
    return undefined;
  }

  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  return body;
}

/**
 * CapacitorHttp.request JSON-serializes `data`. Multipart (and other binary
 * bodies) must keep the webview/patched `fetch` path so the boundary and bytes
 * survive — otherwise `POST /api/files/upload` lands as `{}`.
 */
function isBinaryBody(body: BodyInit | null | undefined): boolean {
  if (body == null || typeof body === 'string') {
    return false;
  }

  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return true;
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return true;
  }

  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
    return true;
  }

  return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body);
}

/**
 * Native webview `fetch` is CORS-bound and has no Hub cookie. CapacitorHttp
 * goes out as a real origin-less request so Traefik/Memory see the call.
 * Web and tests without the plugin keep `window.fetch`.
 */
async function nativeAwareFetch(input: RequestInfo, init: RequestInit, timeout?: number): Promise<Response> {
  const cap = typeof input === 'string' ? capacitorHttp() : undefined;

  if (!cap?.request || typeof input !== 'string' || isBinaryBody(init.body)) {
    return fetch(input, init);
  }

  // URLSession rejects relative paths (`/api/...`) and non-http(s) schemes
  // (`capacitor://…`) as "unsupported URL". Never hand those to CapacitorHttp.
  if (!/^https?:\/\//i.test(input)) {
    throw new Error(
      `Native HTTP needs an absolute http(s) URL (got "${input}"). Pick a Memory Server again.`,
    );
  }

  let result: { status: number; data?: unknown; headers?: HeadersInit };

  try {
    result = await cap.request({
      url: input,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: flattenHeaders(init.headers),
      data: requestData(init.body),
      ...(timeout != null ? { connectTimeout: timeout, readTimeout: timeout } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (/unsupported url/i.test(message)) {
      throw new Error(`Could not request ${input} (${message})`);
    }

    throw err;
  }

  const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? {});

  return new Response(body, { status: result.status, headers: result.headers });
}

/**
 * `fetch` that uses CapacitorHttp on native (no CORS) and resolves string
 * paths against the current Memory origin. Apollo and other callers that need
 * a Response — not parsed JSON — should use this instead of `window.fetch`.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof input === 'string') {
    return nativeAwareFetch(buildApiUrl(input), init ?? {});
  }

  if (input instanceof URL) {
    return nativeAwareFetch(input.toString(), init ?? {});
  }

  return nativeAwareFetch(input, init ?? {});
}

/**
 * Fetch a streaming / binary API response (chat generate, thread attach).
 *
 * CapacitorHttp patches `window.fetch` and buffers the body as UTF-8 text.
 * Chat tokens are length-prefixed binary frames — a payload ≥ 128 bytes
 * puts a non-UTF-8 byte in the length field and the patched path corrupts
 * the stream. Nest already CORS-allows `capacitor://localhost`, so the
 * unpatched webview fetch can stream bytes with `x-api-key`. If that
 * preflight fails, fall back to a buffered but binary-safe CapacitorHttp
 * `arraybuffer` (the reply lands all at once after generation finishes).
 *
 * On-device LocalLLM is a later opt-in. Do not route this helper through
 * `generateOffline` — `isAvailable()` is a RAM floor, not a loaded model.
 */
export async function streamingFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = buildApiUrl(input);
  const headers = {
    ...apiKeyHeaders(),
    ...flattenHeaders(init?.headers),
  };
  const next = { ...init, headers };

  if (!isNativePlatform()) {
    return fetch(url, next);
  }

  try {
    return await unpatchedWebFetch()(url, next);
  } catch {
    return nativeBinaryFetch(url, next);
  }
}

function unpatchedWebFetch(): typeof fetch {
  const w = window as Window & { __ciUnpatchedFetch?: typeof fetch };

  if (w.__ciUnpatchedFetch) {
    return w.__ciUnpatchedFetch;
  }

  if (typeof document === 'undefined') {
    return fetch.bind(window);
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'display:none;width:0;height:0;border:0';
  document.documentElement.appendChild(iframe);

  const childFetch = iframe.contentWindow?.fetch;

  if (typeof childFetch === 'function' && iframe.contentWindow) {
    w.__ciUnpatchedFetch = childFetch.bind(iframe.contentWindow);

    return w.__ciUnpatchedFetch;
  }

  return fetch.bind(window);
}

function decodeCapacitorBinaryBody(data: unknown): BodyInit {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  if (typeof data === 'string') {
    // Capacitor's arraybuffer responseType is a base64 string. A UTF-8 text
    // fallback (plugin ignored responseType) still round-trips through atob
    // only when the payload is actually base64 — otherwise keep the string.
    if (/^[A-Za-z0-9+/]+=*$/.test(data) && data.length % 4 === 0) {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }

      return bytes;
    }

    return data;
  }

  return JSON.stringify(data ?? {});
}

async function nativeBinaryFetch(url: string, init: RequestInit): Promise<Response> {
  const cap = capacitorHttp();

  if (!cap?.request) {
    return fetch(url, init);
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Native HTTP needs an absolute http(s) URL (got "${url}"). Pick a Memory Server again.`);
  }

  const result = await cap.request({
    url,
    method: (init.method ?? 'GET').toUpperCase(),
    headers: flattenHeaders(init.headers),
    data: requestData(init.body),
    responseType: 'arraybuffer',
  });

  return new Response(decodeCapacitorBinaryBody(result.data), {
    status: result.status,
    headers: result.headers,
  });
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
    res = await nativeAwareFetch(resolved, rest, timeout);
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
