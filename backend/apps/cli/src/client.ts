import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';

import type {
  DataSourceSummary,
  DoctorCheckSummary,
  DoctorReport,
  DropSummary,
  InboxBatchResult,
  InboxScan,
  IngestStatus,
  OrchestrateStage,
  OrchestrateSummary,
  PathRecognition,
  RetryFailedPushResult,
  RunDetail,
  RunSummary,
  SourceCatalogEntry,
  UnpushedRunSummary,
} from './wire';

// `IngestStatus` was declared here, and is now in `./wire` with every other
// response shape. Re-exported because it is part of this module's published
// surface and a caller should not have to know which file a body's type sits in.
export type { IngestStatus } from './wire';

/** Safe wire contract for Memory's inference configuration. Credentials are never returned. */
export interface LlmEndpointConfig {
  backend: 'ollama' | 'openai_compatible';
  port: number;
  /** The API root on an OpenAI-compatible backend (`/v1`, or Lemonade's `/api/v1`); absent on Ollama. */
  basePath?: string;
  hostGateway: string;
  locked: boolean;
  endpoint: string;
  apiKeyConfigured: boolean;
}

/** The bounded API-container reachability check exposed by `GET /llm/endpoint/preflight`. */
export interface LlmEndpointPreflight {
  backend: 'ollama' | 'openai_compatible';
  endpoint: string;
  ok: boolean;
  models: string[];
  message?: string;
  status?: number;
}

export interface LlmEndpointUpdate {
  backend: 'ollama' | 'openai_compatible';
  port: number;
  /** OpenAI-compatible only: where the server mounts its API; `/v1` when omitted. */
  basePath?: string;
  /** Write-only replacement for the backend credential. */
  apiKey?: string;
  /** Remove the appliance-saved credential and fall back to runtime config. */
  clearApiKey?: boolean;
}

/** A non-2xx answer from the appliance, carrying its status and its own message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The appliance could not be reached at all — wrong URL, or nothing running. */
export class UnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    cause: unknown,
  ) {
    super(
      `No CI-Server answering at ${baseUrl} (${(cause as Error).message}). ` +
        `Start the stack, or point --server / CI_SERVER_URL at the right one.`,
    );
    this.name = 'UnreachableError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string | null;
  /** Injected in tests; defaults to the global. */
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  form?: FormData;
  query?: Record<string, string | number | undefined>;
}

/**
 * The CLI's whole relationship with the appliance: an authenticated HTTP client
 * over the surfaces the import domain already publishes.
 *
 * Deliberately NOT an in-process Nest context. An import is durable stages on
 * the `import-stages` queue, executed by the API process's workers — a CLI that
 * booted `ImportModule` in its own process would stand up a SECOND set of those
 * workers, racing the server's for the same claims, and would need direct
 * Postgres and object-store credentials besides. Going through the API means a
 * run started here and a run started from the web wizard are not merely
 * equivalent: they are the same `ImportRunService.startRun` call, in the same
 * process, against the same queue.
 *
 * The paths carry no `/api` prefix because the API has no global one. The
 * streaming orchestration call carries `/api` literally because that route
 * declares it itself; ingest status lives on the authenticated `/v1` lifecycle
 * surface.
 */
export class ImportApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  listSources(): Promise<DataSourceSummary[]> {
    return this.request('/import/sources');
  }

  sourceCatalog(): Promise<SourceCatalogEntry[]> {
    return this.request('/import/sources/catalog');
  }

  recognize(path: string): Promise<PathRecognition> {
    return this.request('/import/recognize', { method: 'POST', body: { path } });
  }

  // ---------------------------------------------------------------------------
  // Uploads and runs
  // ---------------------------------------------------------------------------

  /**
   * Stage a local file as an upload drop.
   *
   * The bytes stream: `openAsBlob` hands undici a file-backed Blob, so a 40GB
   * Takeout is read in chunks off disk rather than assembled in the heap. The
   * field name is `files` because that is what the controller's
   * `FilesInterceptor` binds.
   */
  async upload(filePath: string): Promise<DropSummary[]> {
    const form = new FormData();

    form.append('files', await openAsBlob(filePath), basename(filePath));

    return this.request('/import/uploads', { method: 'POST', form });
  }

  startRun(body: { dropId: string; label?: string; stages?: string[] }): Promise<RunDetail> {
    return this.request('/import/runs', { method: 'POST', body });
  }

  listRuns(limit?: number): Promise<RunSummary[]> {
    return this.request('/import/runs', { query: { limit } });
  }

  getRun(runId: string): Promise<RunDetail> {
    return this.request(`/import/runs/${encodeURIComponent(runId)}`);
  }

  listUnpushed(): Promise<UnpushedRunSummary[]> {
    return this.request('/import/runs/unpushed');
  }

  startPush(runIds?: string[]): Promise<{ runs: RunSummary[] }> {
    return this.request('/import/push', { method: 'POST', body: runIds ? { runIds } : {} });
  }

  /** Put a run's `failed` push rows back to `pending` and re-queue its push. */
  retryFailedPush(runId: string): Promise<RetryFailedPushResult> {
    return this.request(`/import/runs/${encodeURIComponent(runId)}/push/retry`, { method: 'POST', body: {} });
  }

  // ---------------------------------------------------------------------------
  // Memory inference setup
  // ---------------------------------------------------------------------------

  getLlmEndpoint(): Promise<LlmEndpointConfig> {
    return this.request('/llm/endpoint');
  }

  preflightLlmEndpoint(): Promise<LlmEndpointPreflight> {
    return this.request('/llm/endpoint/preflight');
  }

  updateLlmEndpoint(settings: LlmEndpointUpdate): Promise<LlmEndpointConfig> {
    return this.request('/llm/endpoint', { method: 'PATCH', body: settings });
  }

  // ---------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------

  scanInbox(): Promise<InboxScan> {
    return this.request('/import/inbox');
  }

  startInboxRuns(units?: string[], label?: string | null): Promise<InboxBatchResult> {
    return this.request('/import/inbox/runs', {
      method: 'POST',
      body: { units, label: label ?? null },
    });
  }

  // ---------------------------------------------------------------------------
  // Doctor
  // ---------------------------------------------------------------------------

  /** The check registry, without running anything. */
  listDoctorChecks(): Promise<DoctorCheckSummary[]> {
    return this.request('/import/doctor/checks');
  }

  /**
   * Run the data-quality suite.
   *
   * No client-side timeout is imposed and none is needed: the per-statement cap
   * is enforced by Postgres on the server, so the response always arrives —
   * with a `timeout` finding rather than a hung socket. That is the whole point
   * of putting the cap in the database rather than in the caller.
   */
  runDoctor(options: { checks?: readonly string[]; timeoutMs?: number } = {}): Promise<DoctorReport> {
    return this.request('/import/doctor', {
      query: {
        checks: options.checks && options.checks.length > 0 ? options.checks.join(',') : undefined,
        timeoutMs: options.timeoutMs,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Ingest lifecycle
  // ---------------------------------------------------------------------------

  ingestStatus(): Promise<IngestStatus> {
    // The old global maintenance route was removed when status moved beside
    // the bulk-ingest lifecycle. Appliance-wide stats are still intentional
    // here: `ci stats` reports the whole local appliance, not one account.
    return this.request('/v1/ingest/status', { query: { scope: 'appliance' } });
  }

  /**
   * Run the enrichment legs, streaming.
   *
   * NDJSON rather than the same endpoint's synchronous JSON, for a reason that
   * is not cosmetic: a search-index backfill runs for hours, and a plain fetch
   * waiting on the FIRST byte of a response would die on undici's 300-second
   * headers timeout long before the work finished. The streaming form writes
   * its headers immediately and heartbeats a `tick` line every ten seconds, so
   * the connection stays honest and the caller sees the legs go by.
   */
  async orchestrate(
    stages: OrchestrateStage[] | undefined,
    options: { abortOnError?: boolean; onLine?: (line: Record<string, unknown>) => void } = {},
  ): Promise<OrchestrateSummary> {
    const url = new URL('/api/maintenance/orchestrate', this.options.baseUrl);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/x-ndjson',
    };

    if (this.options.apiKey) {
      headers['x-api-key'] = this.options.apiKey;
    }

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(stages && stages.length > 0 ? { stages } : {}),
          abortOnError: options.abortOnError ?? false,
        }),
      });
    } catch (err) {
      throw new UnreachableError(this.options.baseUrl, err);
    }

    if (!response.ok) {
      throw new ApiError(
        response.status,
        await describeFailure(response, Boolean(this.options.apiKey)),
        '/api/maintenance/orchestrate',
      );
    }

    let summary: OrchestrateSummary | null = null;

    for await (const line of ndjsonLines(response)) {
      if (line.type === 'result') {
        // The controller spreads the summary alongside its frame tag; drop the
        // tag and keep the rest.
        summary = {
          ok: line.ok,
          legs: line.legs,
          totalDurationMs: line.totalDurationMs,
        } as OrchestrateSummary;
      } else if (line.type === 'error') {
        throw new ApiError(500, String(line.error), '/api/maintenance/orchestrate');
      } else {
        options.onLine?.(line);
      }
    }

    if (summary == null) {
      // The stream ended without its terminating frame: the server went away
      // mid-orchestration. Saying so beats returning an empty summary that
      // reads as "ran, did nothing".
      throw new ApiError(
        502,
        'The orchestration stream ended before it reported a result — the appliance may have restarted.',
        '/api/maintenance/orchestrate',
      );
    }

    return summary;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path, this.options.baseUrl);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { accept: 'application/json' };

    if (this.options.apiKey) {
      headers['x-api-key'] = this.options.apiKey;
    }

    // A FormData body must set its own multipart boundary — naming a
    // content-type here would produce one the server cannot parse.
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      });
    } catch (err) {
      throw new UnreachableError(this.options.baseUrl, err);
    }

    if (!response.ok) {
      throw new ApiError(
        response.status,
        await describeFailure(response, Boolean(this.options.apiKey)),
        path,
      );
    }

    // 204s and empty bodies are legal answers on some of these routes; the
    // callers that get one do not read it.
    const text = await response.text();

    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }
}

/**
 * Yield one parsed object per newline-delimited JSON line.
 *
 * Buffers across chunk boundaries, because a chunk is a network artefact and a
 * line is the unit of meaning — a `leg-result` frame carrying a big result
 * object routinely straddles two. A trailing partial line at end-of-stream is
 * parsed if it is valid JSON and dropped if it is not: a truncated frame is
 * exactly what a killed server leaves behind, and the caller already treats a
 * stream with no `result` as a failure.
 */
async function* ndjsonLines(response: Response): AsyncGenerator<Record<string, unknown>> {
  const body = response.body;

  if (body == null) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf('\n');

    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();

      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');

      if (line.length > 0) {
        yield JSON.parse(line) as Record<string, unknown>;
      }
    }
  }

  const rest = buffer.trim();

  if (rest.length > 0) {
    try {
      yield JSON.parse(rest) as Record<string, unknown>;
    } catch {
      // Truncated final frame; the caller reports the missing result.
    }
  }
}

/**
 * Turn a failed response into a sentence worth printing.
 *
 * Nest's exception filter answers `{ message }` (or an array of them, from a
 * validation pipe); anything else is shown verbatim and truncated, because an
 * HTML error page pasted whole into a terminal helps nobody. A 401 is called
 * out by name: on this API it means the key is missing or wrong, and that is
 * both the likeliest first-run failure and the one with a one-line fix.
 */
async function describeFailure(response: Response, hadKey: boolean): Promise<string> {
  const body = await response.text().catch(() => '');

  return describeFailureBody(response.status, body, hadKey, response.statusText);
}

/**
 * The body-only half of {@link describeFailure}, split out so the GraphQL
 * client ({@link MemoryGraphQLClient} in `./graphqlClient`) can reuse the same
 * "what does a raw HTTP failure on this appliance look like" logic without a
 * second read of an already-consumed response body. GraphQL errors that carry
 * their own `errors[]` array are described separately and never reach this —
 * this is only for the transport-level failures the GraphQL endpoint shares
 * with every REST one: a downed proxy, a body-parser rejection, a plain 5xx.
 */
export function describeFailureBody(status: number, body: string, hadKey: boolean, statusText = ''): string {
  let detail = body.slice(0, 400);

  try {
    const parsed = JSON.parse(body) as { message?: unknown };

    if (typeof parsed.message === 'string') {
      detail = parsed.message;
    } else if (Array.isArray(parsed.message)) {
      detail = parsed.message.join('; ');
    }
  } catch {
    // Not JSON — the truncated body stands.
  }

  if (status === 401 || status === 403) {
    return hadKey
      ? `${status}: the api key was rejected (${detail}). Create a fresh one in the web UI under Settings → API keys.`
      : `${status}: this needs an api key. Set CI_API_KEY, or pass --api-key.`;
  }

  return `${status}: ${detail || statusText}`;
}
