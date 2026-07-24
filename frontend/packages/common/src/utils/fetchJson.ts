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

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  if (timeout != null && rest.signal == null) {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), timeout);
    rest.signal = controller.signal;
  }

  // clear in `finally`: if fetch() rejects (network error, DNS failure) before
  // the timeout fires, skipping the clear would leave the timer pending — it
  // would later abort an already-settled request and keep the event loop alive.
  let res: Response;
  try {
    res = await fetch(input, rest);
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
