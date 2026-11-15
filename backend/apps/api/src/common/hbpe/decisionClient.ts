import { sidecarAuthHeaders } from '@ci/common/sidecar/sidecarAuth';

/**
 * Typed client for the three System 1 decision routes of the HBPE sidecar:
 * `POST /decision/ingress`, `POST /decision/rerank` and `POST /decision/l0`.
 *
 * Every method resolves to `undefined` on any failure (a user id the sidecar
 * would refuse, an empty input, a non-2xx status, a timeout, a network error, a
 * reply of the wrong shape) and never throws, so a caller keeps its current
 * behaviour. Nothing here runs unless a flag in `decisionFlags.ts` asks for it.
 *
 * Wire shapes mirror `backend/apps/hbpe/src/ci/hbpe/api.py`. Inputs are cut to
 * the sidecar's own limits here, measured in code points as Python measures them.
 */

export const HBPE_BASE_URL_ENV = 'HBPE_BASE_URL';
export const HBPE_DEFAULT_BASE_URL = 'http://localhost:8002';

/** The budget for one decision call. A slow sidecar costs the caller nothing but this wait. */
export const DECISION_TIMEOUT_MS = 800;

const MAX_TEXT = 8000;
const MAX_QUERY = 2000;
const MAX_TITLE = 1000;
const MAX_DESCRIPTION = 4000;
const MAX_PASSAGES = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reply of `POST /decision/ingress`. */
export interface MemoryIngressDecision {
  user_id: string;
  intent: string;
  intent_confidence: number;
  intent_distribution: Record<string, number>;
  is_commitment: boolean;
  commitment_probability: number;
  /** Index into the sidecar's sensitivity levels: 0 general, 1 personal, 2 confidential. */
  sensitivity: number;
  sensitivity_distribution: Record<string, number>;
  calibrated: boolean;
}

export interface DecisionPassage {
  id: string;
  text: string;
}

/** One scored passage from `POST /decision/rerank`. `score` is in [0, 1]. */
export interface DecisionRerankItem {
  id: string;
  score: number;
  is_relevant: boolean;
  relevance_probability: number;
  /** Index into the sidecar's freshness levels: 0 stale, 1 recent, 2 active. */
  temporal_freshness: number;
  calibrated: boolean;
}

/** Reply of `POST /decision/l0`. */
export interface L0Classification {
  user_id: string;
  l0_class: string;
  confidence: number;
  distribution: Record<string, number>;
  calibrated: boolean;
}

export interface DecisionClientOptions {
  /** Defaults to `HBPE_BASE_URL`, then {@link HBPE_DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Defaults to {@link DECISION_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Defaults to the global `fetch`, looked up at call time. */
  fetch?: typeof fetch;
  /** Defaults to the sidecar bearer, the same one the other sidecar clients send. */
  headers?: () => Record<string, string>;
}

/** The sidecar base URL from the environment, without a trailing slash. */
export function resolveHbpeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[HBPE_BASE_URL_ENV]?.trim();

  return (configured && configured.length > 0 ? configured : HBPE_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export class DecisionClient {
  private readonly baseUrl: string;

  private readonly timeoutMs: number;

  private readonly fetchImpl: typeof fetch;

  private readonly authHeaders: () => Record<string, string>;

  constructor(options: DecisionClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? resolveHbpeBaseUrl()).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DECISION_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.authHeaders = options.headers ?? sidecarAuthHeaders;
  }

  /**
   * Intent, actionable-commitment and sensitivity for one message or note.
   * `undefined` for empty text or any failure.
   */
  async ingress(userId: string, text: string): Promise<MemoryIngressDecision | undefined> {
    const payload = clip(text, MAX_TEXT);

    if (payload === undefined) {
      return undefined;
    }

    return this.post('/decision/ingress', userId, { text: payload }, isMemoryIngressDecision);
  }

  /**
   * Relevance and freshness of each passage against `query`, best first.
   * `undefined` when the query or every passage is empty, or on any failure.
   * Passages beyond the sidecar's limit of {@link MAX_PASSAGES} are not sent.
   */
  async rerank(
    userId: string,
    query: string,
    passages: readonly DecisionPassage[],
  ): Promise<DecisionRerankItem[] | undefined> {
    try {
      const cleanQuery = clip(query, MAX_QUERY);
      const items: DecisionPassage[] = [];

      for (const passage of passages) {
        const text = clip(passage.text, MAX_TEXT);

        if (
          text !== undefined &&
          typeof passage.id === 'string' &&
          passage.id.length > 0 &&
          items.length < MAX_PASSAGES
        ) {
          items.push({ id: passage.id, text });
        }
      }

      if (cleanQuery === undefined || items.length === 0) {
        return undefined;
      }

      const reply = await this.post(
        '/decision/rerank',
        userId,
        { query: cleanQuery, passages: items },
        isDecisionRerankReply,
      );

      return reply?.results;
    } catch {
      return undefined;
    }
  }

  /** The canonical L0 event class of a title and optional description. `undefined` on failure. */
  async classifyL0(
    userId: string,
    title: string,
    description?: string | null,
  ): Promise<L0Classification | undefined> {
    const cleanTitle = clip(title, MAX_TITLE);

    if (cleanTitle === undefined) {
      return undefined;
    }

    const cleanDescription = description == null ? undefined : clip(description, MAX_DESCRIPTION);

    return this.post(
      '/decision/l0',
      userId,
      { title: cleanTitle, ...(cleanDescription !== undefined ? { description: cleanDescription } : {}) },
      isL0Classification,
    );
  }

  private async post<T>(
    route: string,
    userId: string,
    body: Record<string, unknown>,
    isReply: (value: unknown) => value is T,
  ): Promise<T | undefined> {
    try {
      // The sidecar answers 400 to anything that is not a UUID. Not sending it is cheaper.
      if (!UUID_RE.test(userId)) {
        return undefined;
      }

      const url = `${this.baseUrl}${route}?${new URLSearchParams({ user_id: userId }).toString()}`;
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return undefined;
      }

      const reply: unknown = await response.json();

      return isReply(reply) ? reply : undefined;
    } catch {
      return undefined;
    }
  }
}

/** A client configured from the environment as it is now. Cheap, so callers build one per use. */
export function defaultDecisionClient(): DecisionClient {
  return new DecisionClient();
}

/** `text` cut to `max` code points, or `undefined` when it is empty or whitespace. */
function clip(text: string | null | undefined, max: number): string | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return undefined;
  }

  return Array.from(text).slice(0, max).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMemoryIngressDecision(value: unknown): value is MemoryIngressDecision {
  return isRecord(value) && typeof value.is_commitment === 'boolean' && typeof value.intent === 'string';
}

function isDecisionRerankReply(value: unknown): value is { results: DecisionRerankItem[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.results) &&
    value.results.every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.score === 'number' &&
        Number.isFinite(item.score),
    )
  );
}

function isL0Classification(value: unknown): value is L0Classification {
  return isRecord(value) && typeof value.l0_class === 'string';
}
