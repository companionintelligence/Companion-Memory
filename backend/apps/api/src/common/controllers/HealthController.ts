import { readFile } from 'node:fs/promises';

import { Controller, Get, HttpCode, Optional, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { READ_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { parserAuthHeaders, sidecarAuthHeaders } from '@ci/common/sidecar/sidecarAuth';
import config from '@ci/configuration';
import { FileService } from '@ci/domains/files';
import { OllamaService } from '@ci/domains/llm';

import { API_VERSION, MIN_CLIENT_VERSION } from '../apiContract';

/**
 * How long any ONE dependency probe may take before it is reported as timed
 * out. A monitor polling this endpoint needs an answer about every dependency,
 * so a hung one has to become a data point rather than hold the response — the
 * whole reason the deep check exists is to name the dependency that is stuck.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * The budget handed to the LLM check itself, deliberately INSIDE
 * {@link PROBE_TIMEOUT_MS}. The service's own default is 5s, so with the shared
 * budget alone the check could only ever lose the race and be reported as the
 * controller's generic timeout — never as "the inference backend did not
 * answer", which is the distinction this route exists to draw.
 */
const LLM_PROBE_TIMEOUT_MS = 1_500;

/**
 * How long one deep check is reused before the dependencies are probed again.
 *
 * This route is unauthenticated, and every miss costs a connection out of the
 * app's pg pool plus an outbound call to the inference backend — so without a
 * ceiling, anything that can reach the port can make the appliance probe its
 * own dependencies at request rate. A monitor polling on the usual 10-30s
 * interval still gets a freshly measured answer every time.
 */
const DETAILED_CACHE_TTL_MS = 5_000;

/** Same TTL against the monotonic clock — see {@link probe} on why not `Date.now()`. */
const DETAILED_CACHE_TTL_NS = BigInt(DETAILED_CACHE_TTL_MS) * 1_000_000n;

/** A last successful backup older than this is reported as overdue. */
const BACKUP_OVERDUE_AFTER_MS = 48 * 60 * 60_000;

/** One dependency's probe outcome. */
interface DependencyHealth {
  name: string;
  ok: boolean;
  /** Short, non-sensitive reason. Never an exception message — see {@link failureReason}. */
  detail?: string;
  /** Observed round trip. Runtime observability only; nothing asserts on it. */
  latencyMs?: number;
}

/** What a probe body reports; {@link probe} adds the name and the latency. */
type ProbeResult = Pick<DependencyHealth, 'ok' | 'detail'>;

/** The slice of the appliance backup an administrator is shown (see `backupStatus`). */
interface BackupSummary {
  state: string;
  lastSuccessAt?: string;
  bytes?: number;
  coverage?: string;
}

/** The body of {@link HealthController.detailed}. */
interface DetailedHealth {
  status: 'ok' | 'degraded';
  ok: boolean;
  dependencies: DependencyHealth[];
}

/** Distinguishes "the probe ran out of budget" from "the probe failed". */
class ProbeTimeoutError extends Error {}

/**
 * A probe failure is reported by error CLASS, never by message. Driver errors
 * quote what they were doing — `connect ECONNREFUSED 10.0.0.4:5432`, `password
 * authentication failed for user "ci"` — and this route is unauthenticated, so
 * echoing them would publish the appliance's internal topology, and
 * occasionally a credential, to anyone who can reach the port.
 */
function failureReason(err: unknown): string {
  if (err instanceof ProbeTimeoutError) {
    return `timed out after ${PROBE_TIMEOUT_MS}ms`;
  }

  return `probe failed (${err instanceof Error ? err.constructor.name : typeof err})`;
}

/**
 * Runs one probe under the shared budget. The losing work is NOT cancellable
 * from here — a dependency that accepted the connection and went quiet keeps
 * its socket until its own client gives up — but the response no longer waits
 * on it, which is what a monitor needs.
 */
async function withProbeTimeout<T>(work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      // `Promise.resolve().then` so a probe body that throws SYNCHRONOUSLY
      // (a stubbed client, a missing method) rejects the race instead of
      // escaping past it.
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError()), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Wraps a probe so that neither a rejection nor a timeout can fail the endpoint. */
async function probe(name: string, run: () => Promise<ProbeResult>): Promise<DependencyHealth> {
  // hrtime rather than Date.now(): this is a duration, and a wall-clock step
  // (ntp, a suspended appliance waking up) must not be able to make it negative.
  const startedAt = process.hrtime.bigint();

  const result: ProbeResult = await withProbeTimeout(run).catch((err: unknown) => ({
    ok: false,
    detail: failureReason(err),
  }));

  const latencyMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

  return { name, ...result, latencyMs };
}

@Controller('health')
export class HealthController {
  /** Last completed deep check, kept for {@link DETAILED_CACHE_TTL_MS}. */
  private cached?: { at: bigint; value: DetailedHealth };

  /** The round currently in flight, so concurrent callers wait on one probe. */
  private inFlight?: Promise<DetailedHealth>;

  constructor(
    // Both optional on purpose: the liveness route lives on this controller, so
    // an unwired dependency must degrade to a `not configured` probe rather
    // than make the controller — and `GET /health` with it — unconstructible.
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
    @Optional() private readonly ollama?: OllamaService,
    @Optional() private readonly files?: FileService,
    @Optional() private readonly features?: FeatureService,
  ) {}

  @Get()
  @HttpCode(200)
  check() {
    return {
      status: 'ok',
      // Whether this server accepts CI-Portal OIDC tokens. Capture clients
      // (the browser extension, the applet, the importer) authenticate ONLY
      // with a portal token, so when this is false every one of their requests
      // 401s — and the guard cannot say why, because a rejected token is
      // indistinguishable from an absent one. Surfacing it here turns a silent
      // total failure into something a client can check and report.
      portalAuthEnabled: config.auth.portal.enabled === true,
      // What this process speaks, and the oldest app it still accepts. A client
      // that does not see `apiVersion` treats the server as 0. The route stays
      // `/api/health`: the number is a floor, not a second API to keep alive.
      apiVersion: API_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
    };
  }

  /**
   * Deep health: actually probes the dependencies the appliance's user-visible
   * features need, and reports each one separately.
   *
   * A SECOND route rather than a change to `GET /health`, because that one is
   * the liveness probe CI-Hub and the native clients poll: it has to stay fast,
   * and it must not start failing when a dependency is down — restarting the
   * container does not revive a dead Postgres, it only takes the API away too.
   *
   * This route therefore always answers 200. The HTTP status means "the API
   * answered"; `ok` means "everything it depends on answered", and
   * `dependencies` says WHICH one did not — the thing a monitor cannot infer
   * from a 503.
   *
   * The answer is memoized for {@link DETAILED_CACHE_TTL_MS} — see there for
   * why an unauthenticated route that touches the pool and the inference
   * backend needs a ceiling on how often it actually does so.
   */
  @Get('detailed')
  @HttpCode(200)
  async detailed(): Promise<DetailedHealth> {
    const now = process.hrtime.bigint();

    if (this.cached && now - this.cached.at < DETAILED_CACHE_TTL_NS) {
      return this.cached.value;
    }

    // Callers that arrive while a round is already running share it rather than
    // each starting their own — so a burst costs one round, not one per caller.
    // The previous value is left in place until the new one lands, so a refresh
    // that somehow fails cannot poison the cache.
    this.inFlight ??= this.runProbes().finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }

  /** Authenticated, user-scoped progress. Reachability alone is not pipeline readiness. */
  @Get('operations')
  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireCapability(READ_CAPABILITY)
  async operations(@Context() context: RequestContext) {
    const { userId } = toServiceContext(context);
    const [base, storage, summary, parser, hbpe, progress, syncEnabled] = await Promise.all([
      this.detailed(),
      probe('files', async () => {
        if (!this.files) {
          return { ok: false, detail: 'not configured' };
        }

        await this.files.checkStorage();

        return { ok: true };
      }),
      this.probeSidecar('summaries', config.services.summary.host),
      this.probeSidecar('documents', config.services.parser.host, parserAuthHeaders()),
      this.probeSidecar('predictions', config.services.hbpe.host),
      probe('processing', async () => {
        if (!this.dataSource) {
          return { ok: false, detail: 'not configured' };
        }

        // "Delayed" is late against the job's OWN schedule, not old: a job created
        // days ago for a start time that has only just passed is on time, so a
        // waiting job counts once it is 15 minutes past `start_after`, and an
        // active one once it has run for two hours. A large import can
        // legitimately run that long: this is a prompt to look, never a limit.
        const [row] = await this.dataSource.query(
          `SELECT
          count(*) FILTER (WHERE state = 'created')::int AS waiting,
          count(*) FILTER (WHERE state = 'active')::int AS active,
          count(*) FILTER (WHERE state = 'failed')::int AS failed,
          count(*) FILTER (
            WHERE (state = 'created' AND start_after < now() - interval '15 minutes')
              OR (state = 'active' AND started_on < now() - interval '2 hours')
          )::int AS delayed,
          max(completed_on) FILTER (WHERE state = 'completed') AS "lastCompletedAt"
          FROM pgboss.job WHERE data->>'userId' = $1`,
          [userId],
        );

        return { ok: Number(row?.delayed ?? 0) === 0, ...row };
      }),
      this.features?.isFeatureEnabled('scheduled.connection.sync').catch(() => false) ??
        Promise.resolve(false),
    ]);
    let connections: unknown = null;
    let backup: BackupSummary | null = null;
    let connectionStatus = { name: 'connections', ok: false, detail: 'Status could not be read.' };
    if (this.dataSource) {
      try {
        const [row] = await withProbeTimeout(() =>
          this.dataSource!.query(
            `SELECT
          count(*) FILTER (WHERE active AND NOT needs_reauth)::int AS connected,
          EXISTS(SELECT 1 FROM ci.users WHERE id = $1 AND role = 'admin' AND deleted_at IS NULL) AS "isAdmin",
          count(*) FILTER (WHERE needs_reauth)::int AS "needsSignIn",
          (SELECT max(last_transformed) FROM ci_etl.connection_sync_jobs WHERE user_id = $1) AS "lastSyncedAt",
          (SELECT count(*)::int FROM ci_etl.connection_sync_jobs j
            WHERE j.user_id = $1 AND j.status IN ('pending', 'in_progress')) AS syncing
          FROM ci.connections WHERE user_id = $1`,
            [userId],
          ),
        );
        connections = row;
        if (row?.isAdmin === true) {
          backup = await this.backupStatus();
        }

        connectionStatus = {
          name: 'connections',
          ok: Number(row?.needsSignIn ?? 0) === 0,
          detail: !syncEnabled
            ? 'Automatic syncing is paused.'
            : Number(row?.needsSignIn ?? 0) > 0
              ? 'Sign in to a source again to resume syncing.'
              : 'Source connections checked.',
        };
      } catch {
        // Keep other component outcomes when this one cannot be measured.
      }
    }

    const dependencies = [...base.dependencies, storage, summary, parser, hbpe, progress, connectionStatus];

    return {
      ok: dependencies.every((item) => item.ok),
      at: new Date().toISOString(),
      dependencies,
      connections,
      syncEnabled,
      processing: progress,
      backup,
    };
  }

  /**
   * What an administrator sees of the appliance backup: the outcome the backup scheduler wrote to the JSON
   * status file that `CI_BACKUP_STATUS_FILE` names. Only the state, the last success, the size and what the
   * backup covers leave here: never the file's path and never its error text, whatever else it holds.
   *
   * A last success older than 48 hours is `overdue`, however recent the last attempt was. A file that is
   * unset is `not_configured`; one that cannot be read or parsed is `unavailable`.
   */
  private async backupStatus(): Promise<BackupSummary> {
    const filename = process.env.CI_BACKUP_STATUS_FILE;
    if (!filename) {
      return { state: 'not_configured' };
    }

    try {
      const saved = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;
      const at =
        typeof saved.last_success_at === 'string' && Number.isFinite(Date.parse(saved.last_success_at))
          ? saved.last_success_at
          : undefined;
      const stale = !at || Date.now() - Date.parse(at) > BACKUP_OVERDUE_AFTER_MS;

      return {
        state:
          saved.state === 'failed'
            ? 'failed'
            : stale
              ? 'overdue'
              : saved.state === 'complete'
                ? 'complete'
                : 'unavailable',
        ...(at ? { lastSuccessAt: at } : {}),
        ...(typeof saved.bytes === 'number' && saved.bytes >= 0 ? { bytes: saved.bytes } : {}),
        ...(typeof saved.coverage === 'string' ? { coverage: saved.coverage } : {}),
      };
    } catch {
      return { state: 'unavailable' };
    }
  }

  private probeSidecar(
    name: string,
    host: string,
    headers: Record<string, string> = sidecarAuthHeaders(),
  ): Promise<DependencyHealth> {
    return probe(name, async () => {
      if (!host) {
        return { ok: false, detail: 'not configured' };
      }

      const response = await fetch(`${host.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS),
        headers,
      });
      const body = (await response.json()) as { status?: string };

      return {
        ok: response.ok && body.status === 'ok',
        ...(!(response.ok && body.status === 'ok')
          ? { detail: 'Service or its model needs attention.' }
          : {}),
      };
    });
  }

  private async runProbes(): Promise<DetailedHealth> {
    // Concurrent: the probes are independent round trips, so the endpoint costs
    // the slowest one rather than their sum.
    const dependencies = await Promise.all([this.probePostgres(), this.probeLlm()]);
    const ok = dependencies.every((dependency) => dependency.ok);
    const value: DetailedHealth = {
      status: ok ? 'ok' : 'degraded',
      ok,
      dependencies,
    };

    this.cached = { at: process.hrtime.bigint(), value };

    return value;
  }

  private probePostgres(): Promise<DependencyHealth> {
    return probe('postgres', async () => {
      if (!this.dataSource) {
        return { ok: false, detail: 'not configured' };
      }

      // Through the app's OWN pool: that is what every read path uses, so this
      // also catches a pool that is exhausted or a connection that is up but
      // unusable — both of which a TCP-level check calls healthy.
      await this.dataSource.query('SELECT 1');

      return { ok: true };
    });
  }

  private probeLlm(): Promise<DependencyHealth> {
    return probe('llm', async () => {
      if (!this.ollama) {
        return { ok: false, detail: 'not configured' };
      }

      // `checkChatModel`, NOT `preflightChatModel`: the same definition of "the
      // inference backend is usable", minus the boot-time diagnostics. The
      // preflight logs on every path and overwrites the service's cached
      // preflight state, so polling it from an unauthenticated route would let
      // anyone that can reach the port fill the log and churn that state.
      const preflight = await this.ollama.checkChatModel(LLM_PROBE_TIMEOUT_MS);

      if (!preflight.reachable) {
        return { ok: false, detail: 'inference backend did not answer' };
      }

      if (!preflight.available) {
        // The configured model id stays OUT of the body — this route is
        // unauthenticated, and that id is operator configuration.
        return { ok: false, detail: 'configured chat model is not served' };
      }

      return { ok: true };
    });
  }
}
