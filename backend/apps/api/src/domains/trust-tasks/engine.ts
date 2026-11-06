import type { AskChannelProvenance } from '@ci/domains/asks';
import type { PeerAskBody, PeerAskResponse } from '@ci/domains/peers';

import { ASK_COLLECT_TYPE_URI, ASK_REQUEST_TYPE_URI, ASK_SPECS } from './askSpecs';
import {
  DEFAULT_ACCEPTANCE_WINDOW,
  TrustTaskConsumer,
  type Accepted,
  type AcceptanceWindow,
  type ConsumeMeta,
  type Rejection,
  type ThrottleDecision,
  type TransportIdentity,
} from './consumer';
import { DISCOVERY_SLUG, DISCOVERY_SPECS, discoveryResponsePayload } from './discovery';
import type { JsonObject, TrustTaskDocument } from './document';
import type { DuplicateGuard } from './duplicateGuard';
import { httpStatusFor, type StandardErrorCode } from './errors';
import { buildErrorResponse, buildSuccessResponse, isoSeconds, type DocumentSigner } from './producer';
import { SpecRegistry, type TaskSpecification } from './specs';
import type { VidResolver } from './vid';

/**
 * The Trust Tasks engine: the consumer pipeline, the handlers behind it, and the signing of what comes
 * back. It is a plain class — no Nest, no HTTP — so the whole exchange, refusals included, is
 * testable in-process; `TrustTasksService` supplies the real collaborators and `TrustTasksController`
 * the HTTP.
 *
 * ═══ A SECOND DOOR INTO THE SAME FOUR GATES, NOT A NEW ONE ═══
 *
 * `ask/request` does not decide whether anyone may ask anything. It hands the verified peer and the ask
 * to `PeerAskService.handle`, which runs identity → peer link → grant → disclosure ceiling exactly as
 * it does for `POST /agent/v1/ask`. This file adds no path around any of them. What it adds is a second
 * way to ESTABLISH the peer's identity (an in-band proof over the whole document, instead of an RFC
 * 9421 signature over the HTTP request), which feeds the same `{ issuer: 'did:keri', subject: AID }`
 * the sovereign peer path already produces. The per-peer budgets are the same ones too, spent through
 * the same service — but BEFORE the document is recorded as accepted (see `consumer.ts`).
 *
 * ═══ EVERY DOCUMENT IS SINGLE-USE ═══
 *
 * A document is accepted for execution once. The identical document arriving again is NOT executed and
 * its stored answer is NOT returned: it is absorbed with an empty reply (HTTPS binding §4: "duplicate of a
 * completed execution for which no response was retained → 204"). The peer route behaves the same way —
 * its single-use nonce makes a replayed request yield nothing — whereas answering a duplicate from the
 * record would hand the owner-released answer to anyone who holds the captured bytes for the length of
 * the acceptance window. A producer that lost a response sends a FRESH `ask/collect` document, which is
 * exactly the asker's poll in ADR-0003. A failure AFTER acceptance is reported as not retryable for the
 * same reason: the identical bytes would be absorbed, so the producer is told to send a new document
 * (the carried protocol's `askId` makes that safe).
 *
 * ═══ WHAT AN UNAUTHENTICATED SENDER IS TOLD ═══
 *
 * Nothing but a refusal. A `refused` reply carries no Trust Task document and no reason, and the
 * binding turns it into the same 401 `PeerAskController` gives for every authentication failure. SPEC
 * §7.2 says a consumer SHOULD answer a rejection with an error response; §12.6 and §8.2.1 say such a
 * response is an oracle when the sender is unknown, and the HTTPS binding (§4) itself lists "missing or
 * invalid authentication — transport level, no framework error document" as a row. Once the sender is
 * proved and admitted, the consumer answers with real error documents — but only the codes that can
 * still arise by then: `unavailable` (throttled), `malformedRequest` (payload, or the ask pipeline's own
 * 400), `idConflict`, `internalError`. Everything decided earlier is a bare refusal.
 */

export interface PeerIdentity {
  readonly issuer: string;
  readonly subject: string;
}

export interface AskBackend {
  handle(
    identity: PeerIdentity,
    body: PeerAskBody,
    channel: AskChannelProvenance | null,
  ): Promise<PeerAskResponse>;
  result(identity: PeerIdentity, askId: string): Promise<PeerAskResponse>;
}

export interface Throttle {
  consume(identity: PeerIdentity): Promise<void>;
  consumePoll(identity: PeerIdentity): Promise<void>;
}

export interface EngineDeps {
  readonly signer: DocumentSigner;
  readonly resolver: VidResolver;
  readonly guard: DuplicateGuard;
  readonly asks: AskBackend;
  readonly throttle: Throttle;
  /** Whether a party is one this box deals with at all (an active peer link). Cheap; confers nothing. */
  readonly admit: (vid: string) => Promise<boolean>;
  /** How the ask arrived, for the owner's surfaces; null when it cannot be described. */
  readonly provenance: (vid: string, verifiedAt: Date) => AskChannelProvenance | null;
  readonly window?: AcceptanceWindow;
  readonly now?: () => number;
  /** The operator's log. Rejection reasons go here and nowhere else. */
  readonly log?: (message: string) => void;
}

/** The issuer a sovereign peer link carries; its subject is the peer's `did:keri:D<x>` AID. */
export const SOVEREIGN_ISSUER = 'did:keri';

export type EngineReply =
  | { readonly kind: 'refused' }
  | { readonly kind: 'absorbed' }
  | { readonly kind: 'document'; readonly status: number; readonly document: TrustTaskDocument };

/** `HttpException#getStatus`, without importing Nest into a file that is otherwise independent of it. */
function httpStatusOf(error: unknown): number | undefined {
  const candidate = error as { getStatus?: () => unknown } | null;

  return typeof candidate?.getStatus === 'function' && typeof candidate.getStatus() === 'number'
    ? (candidate.getStatus() as number)
    : undefined;
}

/** The `retryAfterMs` a `PeerRateLimitService` denial carries in its response body, when it carries one. */
function retryAfterMsOf(error: unknown): number | undefined {
  const candidate = error as { getResponse?: () => unknown } | null;
  const body = typeof candidate?.getResponse === 'function' ? candidate.getResponse() : undefined;
  const retryAfterMs = (body as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;

  return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.ceil(retryAfterMs)
    : undefined;
}

export class TrustTasksEngine {
  private readonly specs = new SpecRegistry();

  private readonly consumer: TrustTaskConsumer;

  private readonly window: AcceptanceWindow;

  private readonly now: () => number;

  constructor(private readonly deps: EngineDeps) {
    for (const spec of [...DISCOVERY_SPECS, ...ASK_SPECS]) {
      this.specs.register(spec);
    }

    this.window = deps.window ?? DEFAULT_ACCEPTANCE_WINDOW;
    this.now = deps.now ?? Date.now;
    this.consumer = new TrustTaskConsumer({
      localVid: deps.signer.vid,
      specs: this.specs,
      resolver: deps.resolver,
      guard: deps.guard,
      admit: deps.admit,
      throttle: (issuer, spec) => this.spend(issuer, spec),
      window: this.window,
      now: this.now,
    });
  }

  /** The largest request document any served specification accepts, in bytes (SPEC §7.3 item 21). */
  get maxDocumentBytes(): number {
    return Math.max(...this.specs.list().map((spec) => spec.maxDocumentBytes));
  }

  /** This box's own VID: what peers address documents to. */
  get vid(): string {
    return this.deps.signer.vid;
  }

  async handle(
    received: unknown,
    transport: TransportIdentity = {},
    meta: ConsumeMeta = {},
  ): Promise<EngineReply> {
    const result = await this.consumer.consume(received, transport, meta);

    if (result.kind === 'rejected') {
      return this.reject(result);
    }

    // The identical document, again. Absorbed: not executed, and nothing it earned is handed back.
    if (result.duplicate) {
      this.log(`trust task absorbed as a duplicate: ${result.spec.slug}`);

      return { kind: 'absorbed' };
    }

    try {
      return await this.respond(result);
    } catch (error) {
      return this.failed(result, error);
    }
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  /**
   * The per-peer budget: the ask bucket for `ask/request`, the poll bucket for everything else (a collect
   * or a discovery is a read). Spent through the same service, on the same identity, as the peer route.
   */
  private async spend(issuer: string, spec: TaskSpecification): Promise<ThrottleDecision> {
    const identity: PeerIdentity = { issuer: SOVEREIGN_ISSUER, subject: issuer };

    try {
      if (spec.typeUri === ASK_REQUEST_TYPE_URI) {
        await this.deps.throttle.consume(identity);
      } else {
        await this.deps.throttle.consumePoll(identity);
      }

      return { allowed: true };
    } catch (error) {
      if (httpStatusOf(error) === 429) {
        const retryAfterMs = retryAfterMsOf(error);

        return retryAfterMs === undefined ? { allowed: false } : { allowed: false, retryAfterMs };
      }

      // Anything else (a store that cannot be reached) fails closed: the consumer turns a throw into
      // `unavailable`.
      throw error;
    }
  }

  private errorReply(params: {
    code: StandardErrorCode;
    recipient: string;
    threadId?: string;
    parentThreadId?: string;
    inResponseTo?: { typeUri: string; id?: string };
    retryable?: boolean;
    retryAfterMs?: number;
  }): EngineReply {
    const now = this.now();
    const document = buildErrorResponse({
      signer: this.deps.signer,
      recipient: params.recipient,
      payload: {
        code: params.code,
        ...(params.inResponseTo === undefined ? {} : { inResponseTo: params.inResponseTo }),
        ...(params.retryable === undefined ? {} : { retryable: params.retryable }),
        // Rounded UP to the next whole second: a producer told to wait must never be told to wait too little.
        ...(params.retryAfterMs === undefined
          ? {}
          : { retryAfter: isoSeconds(Math.ceil((now + params.retryAfterMs) / 1000) * 1000) }),
      },
      ...(params.threadId === undefined ? {} : { threadId: params.threadId }),
      ...(params.parentThreadId === undefined ? {} : { parentThreadId: params.parentThreadId }),
      now,
    });

    return { kind: 'document', status: httpStatusFor(params.code), document };
  }

  private reject(rejection: Rejection): EngineReply {
    this.log(`trust task refused: ${rejection.code} (${rejection.reason}) [${rejection.stage}]`);

    if (rejection.stage === 'unauthenticated' || rejection.addressTo === null) {
      return { kind: 'refused' };
    }

    return this.errorReply({
      code: rejection.code,
      recipient: rejection.addressTo,
      ...(rejection.threadId === undefined ? {} : { threadId: rejection.threadId }),
      ...(rejection.parentThreadId === undefined ? {} : { parentThreadId: rejection.parentThreadId }),
      ...(rejection.inResponseTo === undefined ? {} : { inResponseTo: rejection.inResponseTo }),
      ...(rejection.retryAfterMs === undefined ? {} : { retryAfterMs: rejection.retryAfterMs }),
    });
  }

  /**
   * A handler threw after the document was accepted — and so recorded. The identical bytes would be
   * absorbed, so none of these is retryable: the producer is told to send a new document.
   */
  private failed(accepted: Accepted, error: unknown): EngineReply {
    const status = httpStatusOf(error);
    this.log(`trust task handler failed for ${accepted.spec.slug}: ${String(error)}`);

    // The link was revoked between admission and the handler, or the peer is otherwise no longer ours:
    // that is no longer an admitted sender, so it gets the same bare refusal as any other stranger.
    if (status === 401 || status === 403 || status === 404) {
      return { kind: 'refused' };
    }

    return this.errorReply({
      // The ask pipeline's own 400 (a window it will not search, an `askId` reused for another question)
      // is the asker's mistake, exactly as on the peer route; anything else is this box's.
      code: status === 400 || status === 422 ? 'malformedRequest' : 'internalError',
      retryable: false,
      recipient: accepted.issuer,
      threadId: accepted.document.threadId ?? accepted.document.id,
      ...(accepted.document.parentThreadId === undefined
        ? {}
        : { parentThreadId: accepted.document.parentThreadId }),
      inResponseTo: { typeUri: accepted.document.type, id: accepted.document.id },
    });
  }

  private async respond(accepted: Accepted): Promise<EngineReply> {
    const payload = await this.handler(accepted);

    // The response is held to its own specification too (§7.1 item 3): a handler that returns something
    // the schema does not describe is this box's bug, and is reported as one rather than sent.
    const checked = accepted.spec.response?.safeParse(payload);
    if (checked === undefined || !checked.success) {
      throw new Error(`the ${accepted.spec.slug} response did not match its specification`);
    }

    const document = buildSuccessResponse({
      request: accepted.document,
      payload: checked.data as JsonObject,
      signer: this.deps.signer,
      recipient: accepted.issuer,
      now: this.now(),
    });

    return { kind: 'document', status: 200, document };
  }

  private async handler(accepted: Accepted): Promise<unknown> {
    const identity: PeerIdentity = { issuer: SOVEREIGN_ISSUER, subject: accepted.issuer };

    switch (accepted.spec.typeUri) {
      case ASK_REQUEST_TYPE_URI:
        return this.deps.asks.handle(
          identity,
          accepted.payload as PeerAskBody,
          this.deps.provenance(accepted.issuer, new Date(this.now())),
        );

      case ASK_COLLECT_TYPE_URI:
        return this.deps.asks.result(identity, (accepted.payload as { askId: string }).askId);

      default: {
        if (accepted.spec.slug === DISCOVERY_SLUG) {
          return discoveryResponsePayload({
            version: accepted.spec.version as '0.1' | '0.2' | '0.3' | '0.4',
            specs: this.specs.list(),
            patterns: (accepted.payload as { patterns?: string[] }).patterns,
            window: this.window,
          });
        }

        throw new Error(`no handler registered for ${accepted.spec.typeUri}`);
      }
    }
  }
}
