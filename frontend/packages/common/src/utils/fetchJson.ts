import { apiKeyHeaders } from './apiAuth';
import { buildApiUrl } from './apiBase';

interface Opts extends RequestInit {
  timeout?: number;
}

/**
 * Error thrown by {@link fetchJson} for non-2xx responses. Carries the HTTP
 * status so callers can branch on it (e.g. useAuth retries a refresh exactly
 * once on 403 — a stale CSRF token — but never on 401, which means the session
 * itself is invalid).
 */
export class FetchJsonError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`Fetch failed: ${status} ${statusText}`);
    this.name = 'FetchJsonError';
    this.status = status;
  }
}

export async function fetchJson<T>(input: RequestInfo, init?: Opts): Promise<T | undefined> {
  const { timeout, ...rest } = init ?? {};

  // On native, attach the API key (`x-api-key`). No-op on web (returns `{}`), so the
  // request is unchanged. Callers pass plain-object headers, so a shallow merge is
  // safe; the caller's own headers take precedence on the (unused) key collision.
  const keyHeaders = apiKeyHeaders();

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
    throw new FetchJsonError(res.status, res.statusText);
  }

  const text = await res.text();

  return text ? (JSON.parse(text) as T) : undefined;
}
