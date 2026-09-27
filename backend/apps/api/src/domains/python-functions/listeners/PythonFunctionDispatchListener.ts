import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { sidecarAuthHeaders } from '@ci/common/sidecar/sidecarAuth';
import config from '@ci/configuration';
import { OnEvent, type Acknowledgement } from '@ci/domains/events';

import { PythonFunctionRunEvent } from '../events';
import { PythonFunctionTokenService } from '../services/PythonFunctionTokenService';
import {
  PYTHON_FUNCTION_QUEUE_OPTIONS,
  PYTHON_FUNCTION_QUEUES,
  PYTHON_FUNCTIONS,
  type PythonFunctionRunPayload,
  type PythonFunctionTarget,
} from '../types';

// WAS: `type DispatchJob = PythonFunctionRunPayload & { jobId: string }` — a
// hand-written intersection that was the repo's only written admission that the
// event bus smuggled a runtime key through a domain payload. The bus no longer
// writes into the payload; the queue's job id rides `ack.jobId`, where tsc can
// see it.

// The runner replies as soon as the run is accepted into its worker pool, so
// this bounds connection/accept time only — never function runtime.
const DISPATCH_TIMEOUT_MS = 30_000;

// The catalog and health routes are dict lookups on an already-booted service;
// anything slower than this is the sidecar being unreachable, which the
// dispatch immediately after reports on its own.
const PREFLIGHT_TIMEOUT_MS = 5_000;

/**
 * Forwards `python.function.run` jobs to the target Python service and DEFERS
 * pg-boss completion: the job stays `active` (holding no worker slot) until the
 * Python runner reports the outcome through PythonFunctionCallbackController,
 * or the queue's expireInSeconds elapses and pg-boss retries.
 *
 * Both listeners are `autoAcknowledge: false` — a failed dispatch (service
 * down, pool full → 429) calls `fail()` so pg-boss retries with backoff.
 *
 * The first dispatch to each target also runs a one-off catalog preflight
 * (`checkFunctionCatalog`), which is the only thing anywhere that checks the
 * API↔sidecar contract.
 */
@Injectable()
export class PythonFunctionDispatchListener {
  /** One in-flight-or-settled catalog probe per target; see `preflight()`. */
  private readonly preflights = new Map<PythonFunctionTarget, Promise<void>>();

  constructor(
    private readonly logger: LoggerService,
    private readonly tokens: PythonFunctionTokenService,
  ) {
    this.logger.setContext(PythonFunctionDispatchListener.name);
  }

  @OnEvent(PythonFunctionRunEvent, {
    queue: PYTHON_FUNCTION_QUEUES.summary,
    autoAcknowledge: false,
    queueOptions: PYTHON_FUNCTION_QUEUE_OPTIONS.summary,
  })
  async dispatchSummary(payload: PythonFunctionRunPayload, ack: Acknowledgement): Promise<void> {
    await this.dispatch('summary', config.services.summary.host, payload, ack);
  }

  @OnEvent(PythonFunctionRunEvent, {
    queue: PYTHON_FUNCTION_QUEUES.hbpe,
    autoAcknowledge: false,
    queueOptions: PYTHON_FUNCTION_QUEUE_OPTIONS.hbpe,
  })
  async dispatchHbpe(payload: PythonFunctionRunPayload, ack: Acknowledgement): Promise<void> {
    await this.dispatch('hbpe', config.services.hbpe.host, payload, ack);
  }

  private async dispatch(
    target: PythonFunctionTarget,
    baseUrl: string,
    payload: PythonFunctionRunPayload,
    ack: Acknowledgement,
  ): Promise<void> {
    const url = `${baseUrl.replace(/\/+$/, '')}/functions/run`;

    await this.preflight(target, baseUrl);

    try {
      const queue = PYTHON_FUNCTION_QUEUES[target];
      const response = await fetch(url, {
        method: 'POST',
        // The shared bearer gets the request past the sidecar's door.
        headers: { 'Content-Type': 'application/json', ...sidecarAuthHeaders() },
        body: JSON.stringify({
          function: payload.function,
          args: payload.args,
          // What the run may act as: this job's user, until shortly after the
          // queue would expire the job. The only credential the sidecar ever holds.
          access_token: this.tokens.issueRunToken({ userId: payload.userId, jobId: ack.jobId, queue }),
          // From the ACK: this is pg-boss's job id, which is what the sidecar
          // hands back to PythonFunctionCallbackController and what
          // `boss.complete(queue, jobId)` needs. The wire field name is
          // unchanged — the sidecars' pytest suites pin `job_id`.
          job_id: ack.jobId,
          queue,
        }),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');

        throw new Error(`POST ${url} HTTP ${response.status}: ${text.slice(0, 300)}`);
      }

      this.logger.log('Dispatched function run to python service', {
        target,
        functionName: payload.function,
        jobId: ack.jobId,
      });

      // Completion arrives via the callback controller (or queue expiration).
      ack.defer();
    } catch (err) {
      this.logger.warn('Python function dispatch failed — job will retry', {
        target,
        functionName: payload.function,
        jobId: ack.jobId,
        error: err instanceof Error ? err.message : String(err),
      });

      ack.fail(err);
    }
  }

  /**
   * Run the catalog check at most once per target per process.
   *
   * Memoized on the promise, not on a boolean, so concurrent first dispatches
   * share one probe. `checkFunctionCatalog` never rejects, so awaiting this can
   * neither fail a dispatch nor leave a rejected promise cached.
   */
  private preflight(target: PythonFunctionTarget, baseUrl: string): Promise<void> {
    let probe = this.preflights.get(target);

    if (!probe) {
      probe = this.checkFunctionCatalog(target, baseUrl);
      this.preflights.set(target, probe);
    }

    return probe;
  }

  /**
   * Assert that the sidecar actually serves the functions this API dispatches
   * to it, and say so in the log when it does not.
   *
   * A sidecar built from older source answers `GET /health` 200 while 404ing
   * the only route the API uses, so every job on that target fails into retry
   * and then queue expiry — hours of silence in which forecasts and summaries
   * simply stop appearing, with nothing naming the cause. This turns that into
   * one ERROR line at the first dispatch.
   *
   * pythonFunctionRegistryDrift.test.ts pins PYTHON_FUNCTIONS to the sidecar
   * *source*; this is the same assertion against the image actually running,
   * which is the half that a stale or partially-updated appliance breaks.
   *
   * Advisory only: it logs and returns. A broken sidecar must degrade the
   * appliance loudly, not take the API down with it, and the probe itself
   * failing (sidecar still booting, transient network) must not stop a
   * dispatch that may well succeed.
   */
  private async checkFunctionCatalog(target: PythonFunctionTarget, baseUrl: string): Promise<void> {
    const url = `${baseUrl.replace(/\/+$/, '')}/functions`;
    const expected = PYTHON_FUNCTIONS[target];

    try {
      const response = await fetch(url, {
        headers: sidecarAuthHeaders(),
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.error('Python sidecar does not serve its function catalog', {
          target,
          url,
          status: response.status,
          version: await this.reportedVersion(baseUrl),
          expected,
        });

        return;
      }

      const body = (await response.json()) as { functions?: unknown };
      const served = new Set((Array.isArray(body.functions) ? body.functions : []).map(String));
      const missing = expected.filter((name) => !served.has(name));

      if (missing.length > 0) {
        this.logger.error('Python sidecar is missing functions the API dispatches to it', {
          target,
          url,
          missing,
          served: [...served],
          version: await this.reportedVersion(baseUrl),
        });

        return;
      }

      this.logger.log('Python sidecar function catalog matches the dispatch allowlist', {
        target,
        functionCount: expected.length,
      });
    } catch (err) {
      this.logger.warn('Python sidecar function-catalog preflight could not run', {
        target,
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Whatever the sidecar calls itself, for the error above — never throws.
   *
   * Only the summary service reports a `version` today; HBPE's /health does
   * not, so 'not reported' is itself a useful signal about which image is
   * running.
   */
  private async reportedVersion(baseUrl: string): Promise<string> {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
        headers: sidecarAuthHeaders(),
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      });

      if (!response.ok) {
        return `unavailable (health HTTP ${response.status})`;
      }

      const body = (await response.json()) as { version?: unknown };

      return typeof body.version === 'string' ? body.version : 'not reported';
    } catch {
      return 'unavailable';
    }
  }
}
