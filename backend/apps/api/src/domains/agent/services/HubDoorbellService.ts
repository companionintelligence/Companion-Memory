import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  CONNECT_NONCE_HEADER,
  CONNECT_SIGNATURE_HEADER,
  CONNECT_TIMESTAMP_HEADER,
  signConnectRequest,
} from '@ci/common/crypto';
import { devDirectWake, hubBlocker } from '@ci/common/hubDoorbell';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { OPENCLAW_APP_URN } from '../constants';

const WAKE_PATH = '/api/agent-notify/wake';

/** OpenClaw's own gateway hook, which Hub posts to on the far leg. */
const DEV_WAKE_PATH = '/hooks/wake';

/**
 * Memory rings Hub. Hub rings OpenClaw. The packet stays here.
 */
@Injectable()
export class HubDoorbellService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(HubDoorbellService.name);
  }

  async wakeOpenClaw(jobId: string): Promise<boolean> {
    // Hub ALWAYS wins when it is configured, and the dev path is NEVER a
    // fallback after a Hub attempt fails. A configured appliance must not be
    // able to silently prefer the unsigned route because Hub had a bad minute —
    // that is exactly how a dev convenience becomes a production hole. So the
    // branch is on whether Hub is configured, not on whether Hub worked.
    const blocker = hubBlocker();

    if (blocker == null) {
      return this.wakeThroughHub(jobId);
    }

    const direct = devDirectWake();

    if (direct != null) {
      return this.wakeDirectly(jobId, direct);
    }

    this.logger.warn(
      blocker === 'no_hub_url'
        ? 'Skipping OpenClaw doorbell: CI_HUB_INTERNAL_URL is empty'
        : 'Skipping OpenClaw doorbell: CI_HUB_FORWARD_AUTH_SECRET is empty',
    );

    return false;
  }

  /**
   * DEV ONLY. Ring OpenClaw's own hook directly, as Hub would.
   *
   * Deliberately the same request Hub makes — same path, same bearer header,
   * same `{ text, mode }` body, and the same wake TEXT, because CI-OpenClaw's
   * `extractDispatchJobId` reads the job id back out of that sentence. A dev
   * path that exercised a different contract would prove nothing about the
   * real one.
   *
   * Warns on every use rather than once at boot: this must never be running
   * unnoticed on a box someone later promotes.
   */
  private async wakeDirectly(jobId: string, direct: { url: string; token: string }): Promise<boolean> {
    this.logger.warn(
      `Waking OpenClaw DIRECTLY at ${direct.url} — Hub is not configured. This is a dev-only path and must not be set on an appliance.`,
      { jobId },
    );

    try {
      const response = await fetch(`${direct.url}${DEV_WAKE_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${direct.token}`,
        },
        body: JSON.stringify({
          text: `Memory dispatch job ${jobId}. Fetch the packet from Memory.`,
          mode: 'now',
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.logger.warn(`Direct OpenClaw wake returned ${response.status} for job ${jobId}`);

        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn('Direct OpenClaw wake failed', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });

      return false;
    }
  }

  /** The real path: Memory rings Hub, Hub rings OpenClaw. */
  private async wakeThroughHub(jobId: string): Promise<boolean> {
    const base = config.auth.connect.hubInternalUrl?.replace(/\/$/, '') || '';
    const secret = config.auth.hubForwardAuth.secret;

    const body = { appUrn: OPENCLAW_APP_URN, jobId };
    const timestampMs = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const signature = signConnectRequest(secret, 'POST', WAKE_PATH, timestampMs, nonce, body);

    try {
      const response = await fetch(`${base}${WAKE_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CONNECT_TIMESTAMP_HEADER]: String(timestampMs),
          [CONNECT_NONCE_HEADER]: nonce,
          [CONNECT_SIGNATURE_HEADER]: signature,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.logger.warn(`Hub doorbell returned ${response.status} for job ${jobId}`);

        return false;
      }

      // The status code is not the answer. Hub's notify controller returns
      // `{ ok }` from a plain @Post and `wakeApp` returns FALSE — it never
      // throws — when the app has no registered webhook target, when the app is
      // down, or when the wake is throttled. All three arrive here as a 2xx.
      //
      // Reading the status alone reported every undeliverable wake as
      // delivered: the listener then `ack.defer()`s, so pg-boss's retry never
      // engages, and two minutes later the stale reaper closes the job saying
      // "OpenClaw did not check in" — which is the precise opposite of what
      // happened. Nobody was ever asked to check in.
      // Named `outcome`, not `body`: `body` is the REQUEST payload declared above
      // this try block, and re-using the name shadowed it for the whole block —
      // so `JSON.stringify(body)` in the fetch call above referred to this
      // variable in its temporal dead zone. tsc caught it (TS2448/TS2454).
      const outcome = (await response.json().catch(() => null)) as { ok?: unknown } | null;

      if (outcome?.ok !== true) {
        this.logger.warn(`Hub accepted the doorbell but did not deliver it for job ${jobId}`, {
          outcome,
        });

        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn('Hub doorbell failed', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });

      return false;
    }
  }
}
