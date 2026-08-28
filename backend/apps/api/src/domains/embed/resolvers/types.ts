import type { ResolveTarget } from '../resolveKey';
import type { UnfurlFetcher } from '../services/UnfurlFetcher';

/** What a resolver learned about the thing behind a resolve key. */
export interface UnfurlData {
  title?: string;
  authorName?: string;
  authorUrl?: string;
  siteName?: string;
  description?: string;
  canonicalUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  externalRef?: string;
  payload?: Record<string, unknown>;
}

/**
 * Stored statuses — the cache row's `status` column. `unconfigured` is the one
 * that is NOT stored: a resolver that cannot run (a missing credential, should
 * one ever be needed) leaves no row, so the first sweep after it lands resolves
 * for real.
 */
export type UnfurlStatus =
  | 'ok'
  | 'not_found'
  | 'not_embeddable'
  | 'blocked'
  | 'transport_error'
  | 'rate_limited';

export type UnfurlOutcome =
  | { status: 'ok'; data: UnfurlData }
  | { status: Exclude<UnfurlStatus, 'ok'>; detail?: string }
  | { status: 'unconfigured'; detail: string };

export interface UnfurlResolver {
  resolve(target: ResolveTarget, fetcher: UnfurlFetcher): Promise<UnfurlOutcome>;
}

export function str(v: unknown, max = 2000): string | undefined {
  if (typeof v !== 'string') {
    return undefined;
  }

  const t = v.replace(/\s+/g, ' ').trim();

  return t ? t.slice(0, max) : undefined;
}

export function httpUrl(v: unknown): string | undefined {
  const s = str(v, 4000);
  if (!s) {
    return undefined;
  }

  try {
    const u = new URL(s);

    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Maps a non-2xx to the stored vocabulary; 429 is the only retryable one. */
export function statusOutcome(status: number): UnfurlOutcome {
  if (status === 404 || status === 410) {
    return { status: 'not_found' };
  }

  if (status === 401 || status === 403 || status === 451) {
    return { status: 'not_embeddable', detail: `http_${status}` };
  }

  if (status === 429) {
    return { status: 'rate_limited' };
  }

  return { status: 'transport_error', detail: `http_${status}` };
}
