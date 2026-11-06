import {
  DATA_INTEGRITY_PROOF,
  EDDSA_JCS_2022,
  documentDigest,
  verifyEddsaJcs2022Proof,
} from './crypto/dataIntegrity';
import { parseRfc3339, validateStructure, type JsonObject, type TrustTaskDocument } from './document';
import type { DuplicateGuard } from './duplicateGuard';
import type { StandardErrorCode } from './errors';
import { isConsequential, type SpecRegistry, type TaskSpecification } from './specs';
import { parseTypeUri, type ParsedTypeUri } from './typeUri';
import { isProofPurpose, type VidResolver } from './vid';

/**
 * The consumer pipeline — SPEC §7.2, items 1 to 13, in the order this box can afford to run them.
 *
 * It is pure with respect to transport and storage: a clock, a resolver, a duplicate guard, an admission
 * check and a throttle are injected, and what comes out is either an {@link Accepted} document ready for
 * a handler or a {@link Rejection} naming the standard error code. Nothing here knows about HTTP, Nest
 * or Postgres.
 *
 * ═══ THE ORDER, AND WHY IT IS THIS ORDER ═══
 *
 *   1  shape, then `type`, then the specification          cheap, decided from the document alone
 *   2  the size the specification allows                   cheap, and decided BEFORE anything is hashed
 *   3  the freshness window (§7.2 items 4 and 13)           the document and a clock
 *   4  the parties: cross-checks, REQUIRED, recipient       the document and this box's VID
 *   5  audience binding, and "is a proof required?"
 *   6  admission of the CLAIMED identity                    one indexed look-up, no cryptography
 *   7  the proof                                            JCS + SHA-256 + Ed25519: the first real CPU
 *   8  the per-peer throttle, now that the sender has proved who they are and been admitted
 *   9  the payload against the specification's schema
 *   10 the duplicate-execution claim, LAST
 *
 * 6 before 7: a stranger costs one look-up, not a canonicalization of a document someone else chose.
 * The expensive step is reached only by a caller who names an identity this box already deals with, and
 * what that can cost is bounded by the size check in 2. (The peer route does its link look-up before its
 * signature check for the same reason.)
 *
 * 8 and 9 before 10: a record written earlier burns the `id` of a document this box then refuses
 * (HTTPS binding §5.1 item 3). A document turned away by the throttle, or by its payload schema, must be
 * free to be sent again byte for byte, which is what SPEC §8.4 tells a producer to do after a retryable
 * error. The claim is the last thing that happens before a handler runs.
 *
 * ═══ AUTHENTICATION IS NOT AUTHORIZATION (§7.2 item 10) ═══
 *
 * A valid proof from a known issuer establishes WHO made the assertion and that the bytes arrived
 * unaltered. It establishes nothing about whether that party may ask for what the document asks.
 * `admit` answers only "is this a party we deal with at all"; whether the ask is permitted — the
 * grant, the disclosure ceiling — is the handler's business and is never inferred here.
 *
 * Every {@link Rejection} carries a `stage`. A rejection raised before the sender was proved AND
 * admitted is `unauthenticated`: the binding decides whether to say anything about it, and the HTTP
 * binding in this domain says nothing beyond a uniform refusal, for the reason `PeerAskController` gives
 * for its own — a different answer for each failed check maps this box's links and keys for a stranger.
 */

export interface AcceptanceWindow {
  /** The greatest age of `issuedAt`, before tolerance, at which a document is still accepted. */
  readonly maxAgeSeconds: number;
  /** Tolerance applied in both directions to `issuedAt`. */
  readonly clockSkewSeconds: number;
}

/**
 * The window this box applies. It mirrors the peer-signature window (`MAX_SIGNATURE_LIFETIME_MS`,
 * `MAX_CLOCK_SKEW_MS`) so the two doors into the ask pipeline agree on how long a captured request
 * stays useful. No `expiryHorizonSeconds`: for a document that states `issuedAt` (which every
 * consequential specification here REQUIRES) the maximum age applies whatever `expiresAt` it states,
 * which also bounds the duplicate record at a few minutes.
 */
export const DEFAULT_ACCEPTANCE_WINDOW: AcceptanceWindow = { maxAgeSeconds: 300, clockSkewSeconds: 30 };

/** What the transport itself authenticated, when it authenticated anything (SPEC §4.8.1). */
export interface TransportIdentity {
  readonly sender?: string;
  readonly recipient?: string;
}

/** Facts about the delivery that are not in the document. */
export interface ConsumeMeta {
  /** The size in bytes of the body as received. Computed from the document when the binding omits it. */
  readonly bytes?: number;
}

export type ThrottleDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs?: number };

export interface Rejection {
  readonly kind: 'rejected';
  readonly code: StandardErrorCode;
  /** Whether the sender had been proved AND admitted when the document was refused. */
  readonly stage: 'unauthenticated' | 'authenticated';
  /** For the operator's log. Never put this on the wire (SPEC §8.2.1). */
  readonly reason: string;
  /** Who a structured error response is addressed to, or null when none should be sent. */
  readonly addressTo: string | null;
  readonly threadId?: string;
  readonly parentThreadId?: string;
  readonly inResponseTo?: { readonly typeUri: string; readonly id?: string };
  /** Set when the refusal is a throttle: how long until the sender may try again. */
  readonly retryAfterMs?: number;
}

export interface Accepted {
  readonly kind: 'accepted';
  readonly document: TrustTaskDocument;
  readonly type: ParsedTypeUri;
  readonly spec: TaskSpecification;
  /** The payload as the specification's schema parsed it. */
  readonly payload: unknown;
  /** The authenticated issuer. */
  readonly issuer: string;
  /** The verification method the proof named, when there was a proof. */
  readonly verificationMethod: string | undefined;
  /** The same document again: absorbed, not to be executed a second time (§7.2 item 11). */
  readonly duplicate: boolean;
}

export type ConsumeResult = Accepted | Rejection;

export interface ConsumerOptions {
  /** This box's own party: what an incoming `recipient` must equal. */
  readonly localVid: string;
  readonly specs: SpecRegistry;
  readonly resolver: VidResolver;
  readonly guard: DuplicateGuard;
  /**
   * Whether a party is one this box deals with at all. Called with the CLAIMED identity BEFORE the proof is
   * checked, so it must be cheap and must confer nothing: it is a filter, not an authentication.
   */
  readonly admit?: (issuer: string) => Promise<boolean>;
  /**
   * The per-sender budget, spent once per document, after the sender is proved and admitted and before
   * anything durable is written. A refusal or a throw turns the document away as `unavailable`.
   */
  readonly throttle?: (issuer: string, spec: TaskSpecification) => Promise<ThrottleDecision>;
  readonly window?: AcceptanceWindow;
  readonly now?: () => number;
}

type ProofCheck =
  | { readonly ok: true; readonly verificationMethod: string }
  | { readonly ok: false; readonly code: StandardErrorCode; readonly reason: string };

/** The size of a document when the binding did not say. An unserializable one is treated as too large. */
function sizeOf(document: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(document), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export class TrustTaskConsumer {
  private readonly window: AcceptanceWindow;

  private readonly now: () => number;

  constructor(private readonly options: ConsumerOptions) {
    this.window = options.window ?? DEFAULT_ACCEPTANCE_WINDOW;
    this.now = options.now ?? Date.now;
  }

  async consume(
    received: unknown,
    transport: TransportIdentity = {},
    meta: ConsumeMeta = {},
  ): Promise<ConsumeResult> {
    const structure = validateStructure(received);
    let admitted = false;
    let sender = transport.sender;

    const refuse = (
      code: StandardErrorCode,
      reason: string,
      options: { addressTo?: string | null; omitId?: boolean; retryAfterMs?: number } = {},
    ): Rejection => {
      const document = structure.ok ? structure.document : undefined;

      return {
        kind: 'rejected',
        code,
        reason,
        stage: admitted ? 'authenticated' : 'unauthenticated',
        addressTo: options.addressTo !== undefined ? options.addressTo : (sender ?? null),
        ...(document === undefined
          ? {}
          : {
              threadId: document.threadId ?? document.id,
              ...(document.parentThreadId === undefined ? {} : { parentThreadId: document.parentThreadId }),
              inResponseTo: { typeUri: document.type, ...(options.omitId ? {} : { id: document.id }) },
            }),
        ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
      };
    };

    // 1 — shape, type, specification (§7.2 items 1 and 3)
    if (!structure.ok) {
      return refuse('malformedRequest', `shape: ${structure.member}`);
    }

    const document = structure.document;
    const parsed = parseTypeUri(document.type);
    if (!parsed.ok) {
      return refuse('malformedRequest', `type: ${parsed.reason}`);
    }

    const type = parsed.value;
    const lookup = this.options.specs.find(type);
    if ('missing' in lookup) {
      return refuse(lookup.missing, 'type is not served');
    }

    // This endpoint serves requests. A `#response` is somebody's reply, not a task for this box.
    if (type.variant !== 'request') {
      return refuse('unsupportedType', 'a response variant is not served');
    }

    const spec = lookup.found;

    // 2 — the size the specification allows (§7.3 item 21), before anything is canonicalized or hashed
    if ((meta.bytes ?? sizeOf(received)) > spec.maxDocumentBytes) {
      return refuse('malformedRequest', 'larger than the specification allows');
    }

    // 3 — the freshness window (§7.2 items 4 and 13)
    const now = this.now();
    const skewMs = this.window.clockSkewSeconds * 1000;
    const maxAgeMs = this.window.maxAgeSeconds * 1000;
    const issuedAt =
      document.issuedAt === undefined ? undefined : (parseRfc3339(document.issuedAt) ?? undefined);
    const expiresAt =
      document.expiresAt === undefined ? undefined : (parseRfc3339(document.expiresAt) ?? undefined);

    if (spec.issuedAt === 'REQUIRED' && issuedAt === undefined) {
      return refuse('malformedRequest', 'issuedAt is required');
    }

    // Both refusals below are `malformedRequest`, not `expired`: neither document was ever acceptable,
    // so telling the sender to wait would be wrong — it must reissue.
    if (issuedAt !== undefined && issuedAt > now + skewMs) {
      return refuse('malformedRequest', 'issuedAt is in the future');
    }

    if (issuedAt !== undefined && expiresAt !== undefined && expiresAt <= issuedAt) {
      return refuse('malformedRequest', 'expiresAt is not after issuedAt');
    }

    if (expiresAt !== undefined && now >= expiresAt) {
      return refuse('expired', 'expiresAt has passed');
    }

    let acceptanceEnd: number | undefined = expiresAt;
    if (issuedAt !== undefined) {
      const ageEnd = issuedAt + maxAgeMs;
      if (now > ageEnd + skewMs) {
        return refuse('expired', 'older than the acceptance window');
      }

      acceptanceEnd = expiresAt === undefined ? ageEnd : Math.min(expiresAt, ageEnd);
    }

    // 4 — the parties (§4.8.1; §7.2 items 5 and 6)
    const issuerInBand = document.issuer;
    const recipientInBand = document.recipient;

    if (issuerInBand !== undefined && transport.sender !== undefined && issuerInBand !== transport.sender) {
      // The in-band issuer is the contested identity, so it is NOT who the answer goes to (§8.1).
      return refuse('identityMismatch', 'issuer differs from the transport sender', {
        addressTo: transport.sender,
        omitId: true,
      });
    }

    if (
      recipientInBand !== undefined &&
      transport.recipient !== undefined &&
      recipientInBand !== transport.recipient
    ) {
      return refuse('identityMismatch', 'recipient differs from the transport recipient', {
        addressTo: transport.sender ?? null,
        omitId: true,
      });
    }

    if (spec.parties.issuer === 'REQUIRED' && issuerInBand === undefined) {
      return refuse('malformedRequest', 'issuer is required');
    }

    if (spec.parties.recipient === 'REQUIRED' && recipientInBand === undefined) {
      return refuse('malformedRequest', 'recipient is required');
    }

    if (recipientInBand !== undefined && recipientInBand !== this.options.localVid) {
      return refuse('wrongRecipient', 'recipient is another party');
    }

    // 5 — audience binding (§4.8.2, §7.2 item 8): a proof that does not cover an audience can be replayed
    // to a different consumer, so a proof-carrying document must name its recipient.
    if (document.proof !== undefined && recipientInBand === undefined && !spec.bearer) {
      return refuse('malformedRequest', 'a proof requires an in-band recipient');
    }

    if (document.proof === undefined && spec.proof.request === 'REQUIRED') {
      return refuse('proofRequired', 'the specification requires a proof');
    }

    // 6 — admission of the claimed identity: one look-up, before any cryptography is spent on a stranger.
    const claimed = document.proof === undefined ? transport.sender : issuerInBand;
    if (claimed !== undefined && this.options.admit !== undefined && !(await this.options.admit(claimed))) {
      return refuse('permissionDenied', 'the claimed sender is not admitted');
    }

    // 7 — the proof (§7.2 item 7)
    let verificationMethod: string | undefined;
    if (document.proof !== undefined) {
      const check = await this.checkProof(document, issuerInBand);
      if (!check.ok) {
        return refuse(check.code, check.reason);
      }

      verificationMethod = check.verificationMethod;
      sender = issuerInBand;
    }

    // Without a verified proof the only authenticated identity is the transport's; with neither, nobody
    // has been authenticated at all.
    if (sender === undefined) {
      return refuse('permissionDenied', 'the sender is not authenticated');
    }

    admitted = true;

    // 8 — the per-peer budget, spent before anything durable is written (see the header)
    if (this.options.throttle !== undefined) {
      try {
        const decision = await this.options.throttle(sender, spec);
        if (!decision.allowed) {
          return refuse('unavailable', 'the sender is over its budget', {
            ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs }),
          });
        }
      } catch {
        return refuse('unavailable', 'the throttle could not be consulted');
      }
    }

    // 9 — the payload (§7.2 item 2). The schema is closed: an unrecognized member is `malformedRequest`.
    const payload = spec.request.safeParse(document.payload);
    if (!payload.success) {
      return refuse('malformedRequest', 'payload does not match the specification');
    }

    // 10 — the duplicate-execution claim (§7.2 item 11), for a task that is not safe to repeat.
    let duplicate = false;
    if (isConsequential(spec) && !spec.repeatSafe) {
      // §7.2 "Bounding the record": no window to place the document in means no safe way to remember it.
      if (acceptanceEnd === undefined) {
        return refuse('malformedRequest', 'a consequential task needs issuedAt or expiresAt');
      }

      try {
        const outcome = await this.options.guard.claim({
          id: document.id,
          digest: documentDigest(document),
          now,
          expiresAtMs: acceptanceEnd + skewMs + 1000,
        });

        if (outcome === 'conflict') {
          return refuse('idConflict', 'a different document owns this id');
        }

        duplicate = outcome === 'duplicate';
      } catch {
        // Cannot establish whether this is a duplicate, so it must not execute (binding §5.1 item 5).
        return refuse('unavailable', 'the duplicate record is unavailable');
      }
    }

    return {
      kind: 'accepted',
      document,
      type,
      spec,
      payload: payload.data,
      issuer: sender,
      verificationMethod,
      duplicate,
    };
  }

  /**
   * SPEC §4.7 and §4.7.3: the suite is one we verify, the purpose names a relationship, the verification
   * method is the issuer's own and is authorized for that relationship, and the signature holds over the
   * document as received. Every failure is `proofInvalid` on the wire; the reason is for the log.
   */
  private async checkProof(document: TrustTaskDocument, issuer: string | undefined): Promise<ProofCheck> {
    const proof: JsonObject | undefined = document.proof;
    if (proof === undefined || issuer === undefined) {
      return { ok: false, code: 'proofInvalid', reason: 'a proof needs an in-band issuer' };
    }

    // An unsupported suite is a failure, never "treat it as unsigned" (§4.7.1).
    if (proof.type !== DATA_INTEGRITY_PROOF || proof.cryptosuite !== EDDSA_JCS_2022) {
      return { ok: false, code: 'proofInvalid', reason: 'unsupported proof type or cryptosuite' };
    }

    const purpose = proof.proofPurpose;
    const methodId = proof.verificationMethod;
    if (!isProofPurpose(purpose) || typeof methodId !== 'string') {
      return { ok: false, code: 'proofInvalid', reason: 'proofPurpose or verificationMethod is not usable' };
    }

    let controller;
    try {
      controller = await this.options.resolver.resolve(issuer);
    } catch {
      // The resolver failed; the document was neither refused nor found invalid (§8.3, `indeterminate`).
      return { ok: false, code: 'indeterminate', reason: 'the issuer could not be resolved' };
    }

    if (controller == null || controller.id !== issuer) {
      return { ok: false, code: 'proofInvalid', reason: 'the issuer does not resolve' };
    }

    const method = controller.verificationMethods.find((candidate) => candidate.id === methodId);
    if (method === undefined || method.controller !== issuer || !method.relationships.has(purpose)) {
      return {
        ok: false,
        code: 'proofInvalid',
        reason: 'the verification method is not the issuer’s for this purpose',
      };
    }

    // Verified over the object AS RECEIVED — never over a normalized copy (§4.7).
    if (!verifyEddsaJcs2022Proof(document, method.publicKey)) {
      return { ok: false, code: 'proofInvalid', reason: 'the signature does not verify' };
    }

    return { ok: true, verificationMethod: methodId };
  }
}
