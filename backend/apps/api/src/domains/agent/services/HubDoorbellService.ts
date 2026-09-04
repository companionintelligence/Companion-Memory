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
