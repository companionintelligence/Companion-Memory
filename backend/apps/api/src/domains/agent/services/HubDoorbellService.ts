import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  CONNECT_NONCE_HEADER,
  CONNECT_SIGNATURE_HEADER,
  CONNECT_TIMESTAMP_HEADER,
  signConnectRequest,
} from '@ci/common/crypto';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { OPENCLAW_APP_URN } from '../constants';

const WAKE_PATH = '/api/agent-notify/wake';

/**
 * Memory rings Hub. Hub rings OpenClaw. The packet stays here.
 */
@Injectable()
export class HubDoorbellService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(HubDoorbellService.name);
  }

  async wakeOpenClaw(jobId: string): Promise<boolean> {
    const base = config.auth.connect.hubInternalUrl?.replace(/\/$/, '') || '';
    const secret = config.auth.hubForwardAuth.secret;

    if (!base) {
      this.logger.warn('Skipping OpenClaw doorbell: CI_HUB_INTERNAL_URL is empty');

      return false;
    }

    if (!secret) {
      this.logger.warn('Skipping OpenClaw doorbell: CI_HUB_FORWARD_AUTH_SECRET is empty');

      return false;
    }

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
