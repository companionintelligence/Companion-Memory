import { createPrivateKey, randomBytes, type KeyObject } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { CONSUMPTION_STORE, type ConsumptionStore } from '@ci/domains/consumption';

import {
  BODY_COMPONENT,
  PEER_SIGNATURE_ALG,
  PEER_SIGNATURE_LABEL,
  REQUIRED_COMPONENTS,
  SignatureFormatError,
  buildSignatureBase,
  contentDigest,
  coversRequiredComponents,
  formatSignatureParams,
  jwkThumbprint,
  parseSignatureHeaders,
  publicKeyFromJwk,
  signSignatureBase,
  verifyContentDigest,
  verifySignatureBase,
} from '../httpSignature';

/**
 * How far a peer's clock may be ahead of ours before a signature is refused.
 *
 * Small, but not zero: a `created` in the future is normally skew, and refusing
 * every skewed peer outright would make federation depend on NTP. Large enough
 * to be useful and small enough that it does not meaningfully widen the replay
 * window {@link MAX_SIGNATURE_LIFETIME_MS} bounds.
 */
export const MAX_CLOCK_SKEW_MS = 30_000;

/**
 * The longest validity window this box will honour, whatever the signature says.
 *
 * `expires` is chosen by the SENDER, so without a ceiling here a peer signs one
 * request with a year-long window and has a year-long bearer token again --
 * which is the exact property this module exists to remove. The nonce cache
 * only has to remember a nonce for this long, so the bound is also what keeps
 * that cache finite.
 */
export const MAX_SIGNATURE_LIFETIME_MS = 300_000;

/** The window this box asks for on its own outbound requests. */
const OUTBOUND_LIFETIME_MS = 60_000;

export type SignatureFailure =
  | 'missing'
  | 'malformed'
  | 'unsupported-components'
  | 'bad-digest'
  | 'expired'
  | 'window-too-long'
  | 'clock-skew'
  | 'replayed'
  | 'unknown-key'
  | 'bad-signature';

export type VerificationResult =
  { ok: true; keyThumbprint: string } | { ok: false; reason: SignatureFailure };

/**
 * Verifies and produces RFC 9421 signatures on the peer-ask surface.
 *
 * The pure arithmetic is in `httpSignature.ts`; what lives here is everything
 * that needs a clock, a key, or memory of what has already been seen:
 *
 *   * the validity window, bounded at BOTH ends (see
 *     {@link MAX_SIGNATURE_LIFETIME_MS} for why the sender does not get to
 *     choose how long its own signature lives);
 *   * the nonce cache, which is the actual replay defence -- a window alone
 *     lets the same request be delivered as many times as fits inside it;
 *   * this box's own signing key.
 *
 * ASSURANCE MAY ONLY TIGHTEN. A verified signature raises no privilege on its
 * own. It answers "which key sent this", and the owner's `trust_tier` on the
 * peer link -- a thing the owner wrote down -- is the only input that relaxes
 * anything. That direction is UMA-for-agents' finding #13, and it is why this
 * service returns a thumbprint rather than a decision.
 */
@Injectable()
export class PeerSignatureService {
  private cachedSigningKey: { key: KeyObject; thumbprint: string } | null | undefined;

  constructor(
    @Inject(CONSUMPTION_STORE)
    private readonly store: ConsumptionStore,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerSignatureService.name);
  }

  /** Whether a valid signature is REQUIRED on the peer surface, or merely honoured. */
  get required(): boolean {
    return config.peers?.requireHttpSignature === true;
  }

  /**
   * Verify a signed inbound request against one peer's registered public key.
   *
   * `rawBody` is the exact bytes the digest was computed over -- not a
   * re-encoded object. Re-serializing before digesting is the classic way to
   * make a signature check pass over content the sender never signed, because
   * `JSON.stringify` of a parsed object is not guaranteed to reproduce the
   * input byte for byte.
   */
  async verifyInbound(request: {
    method: string;
    targetUri: string;
    signatureInput?: string;
    signature?: string;
    contentDigestHeader?: string;
    rawBody?: string;
    peerPublicJwk: unknown;
    now?: Date;
  }): Promise<VerificationResult> {
    if (!request.signatureInput && !request.signature) {
      return { ok: false, reason: 'missing' };
    }

    let parsed;
    try {
      parsed = parseSignatureHeaders(request.signatureInput, request.signature);
    } catch (error) {
      if (error instanceof SignatureFormatError) {
        return { ok: false, reason: 'malformed' };
      }

      throw error;
    }

    const hasBody = request.rawBody != null && request.rawBody.length > 0;

    // Derived from the REQUEST, never from the signature -- a sender must not
    // be able to drop the body binding by declining to cover it.
    if (!coversRequiredComponents(parsed.params.components, hasBody)) {
      return { ok: false, reason: 'unsupported-components' };
    }

    if (hasBody && !verifyContentDigest(request.contentDigestHeader, request.rawBody as string)) {
      return { ok: false, reason: 'bad-digest' };
    }

    const now = (request.now ?? new Date()).getTime();
    const createdMs = parsed.params.created * 1000;
    const expiresMs = parsed.params.expires * 1000;

    if (createdMs - now > MAX_CLOCK_SKEW_MS) {
      return { ok: false, reason: 'clock-skew' };
    }

    if (expiresMs <= now) {
      return { ok: false, reason: 'expired' };
    }

    if (expiresMs - createdMs > MAX_SIGNATURE_LIFETIME_MS) {
      return { ok: false, reason: 'window-too-long' };
    }

    const verifyingKey = publicKeyFromJwk(request.peerPublicJwk);
    if (verifyingKey == null) {
      return { ok: false, reason: 'unknown-key' };
    }

    let thumbprint: string;
    try {
      thumbprint = jwkThumbprint(request.peerPublicJwk as Record<string, unknown>);
    } catch {
      return { ok: false, reason: 'unknown-key' };
    }

    // THE keyid MUST NAME THE KEY WE ARE ABOUT TO VERIFY WITH. Without this the
    // `keyid` is decorative: a sender could name any key at all and still be
    // verified against whichever one the link happens to hold, which quietly
    // turns a key-identified request back into a link-identified one.
    if (parsed.params.keyid !== thumbprint) {
      return { ok: false, reason: 'unknown-key' };
    }

    let base: string;
    try {
      base = buildSignatureBase({
        components: parsed.params.components,
        method: request.method,
        targetUri: request.targetUri,
        contentDigestHeader: request.contentDigestHeader,
        rawParams: parsed.rawParams,
      });
    } catch {
      return { ok: false, reason: 'unsupported-components' };
    }

    if (!verifySignatureBase(base, parsed.signature, verifyingKey)) {
      return { ok: false, reason: 'bad-signature' };
    }

    // REPLAY IS CHECKED LAST, and only for a signature that is otherwise valid.
    // Checking it earlier would let an attacker burn a victim's nonce by
    // replaying it with a broken signature, denying the honest request that
    // follows. Scoped by thumbprint so one peer cannot burn another's.
    const claimed = await this.store.claimOnce({
      key: `peer-nonce:${thumbprint} ${parsed.params.nonce}`,
      now,
      expiresAtMs: expiresMs,
    });

    if (!claimed) {
      return { ok: false, reason: 'replayed' };
    }

    return { ok: true, keyThumbprint: thumbprint };
  }

  /**
   * Headers that sign an outbound request, or `null` when this box has no
   * signing key configured.
   *
   * Null rather than throwing: signing is additive while
   * `peers.requireHttpSignature` is rolling out, and a box with no key must
   * still be able to talk to a peer that does not require one.
   */
  signOutbound(request: {
    method: string;
    targetUri: string;
    body?: string;
    now?: Date;
  }): Record<string, string> | null {
    const signing = this.signingKey();
    if (signing == null) {
      return null;
    }

    const hasBody = request.body != null && request.body.length > 0;
    const digest = hasBody ? contentDigest(request.body as string) : undefined;
    const created = Math.floor((request.now ?? new Date()).getTime() / 1000);

    const params = {
      components: [...REQUIRED_COMPONENTS, ...(hasBody ? [BODY_COMPONENT] : [])],
      created,
      expires: created + OUTBOUND_LIFETIME_MS / 1000,
      keyid: signing.thumbprint,
      alg: PEER_SIGNATURE_ALG,
      // 128 bits, base64url -- comfortably inside NONCE_PATTERN and far beyond
      // any birthday concern over the five minutes a nonce can live.
      nonce: randomBytes(16).toString('base64url'),
    };

    const rawParams = formatSignatureParams(params);
    const base = buildSignatureBase({
      components: params.components,
      method: request.method,
      targetUri: request.targetUri,
      contentDigestHeader: digest,
      rawParams,
    });

    return {
      ...(digest ? { 'content-digest': digest } : {}),
      'signature-input': `${PEER_SIGNATURE_LABEL}=${rawParams}`,
      signature: `${PEER_SIGNATURE_LABEL}=:${signSignatureBase(base, signing.key).toString('base64')}:`,
    };
  }

  /** This box's own key thumbprint, for publishing to peers. Null when unconfigured. */
  get publicThumbprint(): string | null {
    return this.signingKey()?.thumbprint ?? null;
  }

  /**
   * Load and cache this box's Ed25519 signing key from config.
   *
   * `undefined` means "not looked at yet"; `null` means "looked, and there is
   * none" -- so a missing key is resolved once rather than re-parsed and
   * re-warned on every outbound request.
   */
  private signingKey(): { key: KeyObject; thumbprint: string } | null {
    if (this.cachedSigningKey !== undefined) {
      return this.cachedSigningKey;
    }

    const raw = config.peers?.signingKeyJwk;
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
      this.cachedSigningKey = null;

      return null;
    }

    try {
      const jwk = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const key = createPrivateKey({ key: jwk, format: 'jwk' });
      // The thumbprint identifies the PUBLIC half; `d` is dropped by taking
      // only the three required OKP members.
      const thumbprint = jwkThumbprint(jwk as Record<string, unknown>);

      this.cachedSigningKey = { key, thumbprint };
    } catch (error) {
      // Never throw out of here: a misconfigured key must degrade to "this box
      // does not sign", not take down every outbound ask.
      this.logger.warn(`peers.signingKeyJwk is unusable, outbound asks will be unsigned: ${String(error)}`);
      this.cachedSigningKey = null;
    }

    return this.cachedSigningKey;
  }
}
