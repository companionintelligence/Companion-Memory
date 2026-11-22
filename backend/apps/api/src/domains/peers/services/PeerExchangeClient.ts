import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { newIdentityChallenge, verifyIdentityProof } from '../identityProof';
import { publishedBase } from '../peerRequest';
import { EgressBlockedError, peerEgressFetch } from '../urlPolicy';

import type { PeerSigner } from './PeerIdentityService';
import { PeerSignatureService } from './PeerSignatureService';

/** Why a call to another box did not give a usable answer, in words this box chose. */
export type ExchangeFailure = 'not-permitted' | 'unreachable' | 'refused' | 'bad-proof';

export type ExchangeResult<T> =
  { ok: true; value: T } | { ok: false; reason: ExchangeFailure; status?: number };

/**
 * The calls one box makes to another to LINK people: fetch an identity proof,
 * accept an invite, send a key-rotation or unlink notice. `PeerAskClient` keeps
 * the ask and collect calls; both dial only through `peerEgressFetch`, so the
 * SSRF guard (policy, connect-time address pin, no redirects) covers these too.
 *
 * Everything the other box returns is untrusted: proofs are verified here
 * against what THIS box expected, and nothing it says is passed on unchecked.
 */
@Injectable()
export class PeerExchangeClient {
  constructor(
    private readonly signatureService: PeerSignatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerExchangeClient.name);
  }

  /**
   * Check that the box at `endpoint` holds the key `didKey` names, right now.
   * `ok` only for a proof signed by that key, over that endpoint, answering a
   * challenge minted here for this call.
   */
  async verifyIdentity(endpoint: string, didKey: string): Promise<ExchangeResult<void>> {
    const base = publishedBase(endpoint);
    if (base == null) {
      return { ok: false, reason: 'not-permitted' };
    }

    const challenge = newIdentityChallenge();
    const url = `${base}/identity/${encodeURIComponent(didKey)}?challenge=${challenge}`;
    const response = await this.request(url, { method: 'GET' });

    if (!response.ok) {
      return response;
    }

    if (!verifyIdentityProof(response.value, { didKey, endpoint: base, challenge })) {
      this.logger.warn(`identity proof from ${base} did not verify`);

      return { ok: false, reason: 'bad-proof' };
    }

    return { ok: true, value: undefined };
  }

  /**
   * POST a JSON body to `<endpoint><path>`, signed by `signer` and sent with no
   * token (`Bearer keri`): the signature is the whole authentication, as on a
   * token-less ask.
   */
  async postSigned(
    endpoint: string,
    path: string,
    body: unknown,
    signer: PeerSigner,
  ): Promise<ExchangeResult<unknown>> {
    const base = publishedBase(endpoint);
    if (base == null) {
      return { ok: false, reason: 'not-permitted' };
    }

    const url = `${base}${path}`;
    const raw = JSON.stringify(body);
    const signature = this.signatureService.signOutbound(
      { method: 'POST', targetUri: url, body: raw },
      signer,
    );

    return this.request(url, {
      method: 'POST',
      body: raw,
      headers: { authorization: 'Bearer keri', 'content-type': 'application/json', ...(signature ?? {}) },
    });
  }

  private async request(
    url: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
  ): Promise<ExchangeResult<unknown>> {
    try {
      const response = await peerEgressFetch(url, {
        method: init.method,
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
        ...(init.body == null ? {} : { body: init.body }),
        signal: AbortSignal.timeout(config.peers?.timeoutMs ?? 10_000),
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        this.logger.warn(`peer exchange ${init.method} ${url} → ${response.status}`);

        return { ok: false, reason: 'refused', status: response.status };
      }

      return { ok: true, value: (await response.json()) as unknown };
    } catch (error: unknown) {
      if (error instanceof EgressBlockedError) {
        this.logger.warn(`refusing peer endpoint ${url}: ${error.reason}`);

        return { ok: false, reason: 'not-permitted' };
      }

      this.logger.warn(`peer exchange ${url} failed: ${error instanceof Error ? error.name : 'error'}`);

      return { ok: false, reason: 'unreachable' };
    }
  }
}
