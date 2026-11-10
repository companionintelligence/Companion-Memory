/**
 * What every operation shares: the resolved configuration, the open transaction, the request, the
 * route and who is asking, plus the helpers that keep operations short and uniform (JSON bodies,
 * preconditions, authorization against the effective policy).
 */
import { decide, policyGrantsRead, refusal } from './access';
import type { AccessEnv, CapabilityRule } from './access';
import type { Authn, NormalizedRequest } from './authn';
import { evaluatePreconditions } from './conditional';
import type { Precondition } from './conditional';
import type { JsonObject } from './dataIntegrity';
import { isJsonMediaType, jsonResponse } from './http';
import type { PwsResponse } from './http';
import type { DidRegistry } from './keys';
import type { PolicyScope } from './models';
import type { PageLimits } from './pagination';
import { PwsError, invalidBody } from './problems';
import type { PwsUrls, Route } from './routes';
import type { InstanceDisclosure } from './serviceDescription';
import type { Stamp, StampClock } from './stamp';
import type { PwsStore, PwsTx } from './store';

export interface HandlerEnv {
  urls: PwsUrls;
  keys: DidRegistry;
  store: PwsStore;
  now(): Date;
  generateId(): string;
  /** The hybrid logical clock that stamps writes (see `stamp.ts`). */
  clock: StampClock;
  skewSeconds: number;
  maxChainLength: number;
  maxSignatureLifetimeSeconds: number;
  /** Largest Resource body accepted; larger is `payload-too-large` (413). */
  maxUploadBytes: number;
  /** Largest JSON document (Metadata objects, policies) accepted. */
  maxJsonBytes: number;
  page: PageLimits;
  isRevoked?: (capabilityId: string) => Promise<boolean>;
  instance?: InstanceDisclosure;
  corsAllowOrigin: string;
  /** `Content-Security-Policy` sent with Resource content; null to send none. */
  resourceContentSecurityPolicy: string | null;
}

export class OpContext {
  readonly url: URL;

  constructor(
    readonly env: HandlerEnv,
    readonly tx: PwsTx,
    readonly req: NormalizedRequest,
    readonly route: Route,
    readonly authn: Authn,
    readonly now: Date,
  ) {
    this.url = new URL(req.url);
  }

  /**
   * A fresh write stamp. `prior` is the stamp of the version being replaced: observing it first keeps the new
   * stamp after it even from a new clock (a restart, a second handler over the same store, a wall clock that
   * is behind).
   */
  stamp(prior?: Stamp): Stamp {
    if (prior) {
      this.env.clock.observe(prior);
    }

    return this.env.clock.tick(this.now);
  }

  get method(): string {
    return this.req.method;
  }

  header(name: string): string | undefined {
    return this.req.headers[name];
  }

  json(status: number, value: unknown, headers: Record<string, string> = {}): PwsResponse {
    return jsonResponse(status, value, headers);
  }

  // --- request bodies ------------------------------------------------------------------------

  /** The body as a JSON value, for the Metadata objects and policies. */
  jsonBody(): unknown {
    const contentType = this.header('content-type');
    if (contentType === undefined) {
      throw new PwsError('missing-content-type', 'A Content-Type header is required.');
    }

    if (!isJsonMediaType(contentType)) {
      throw invalidBody('The request body must be application/json.');
    }

    if (this.req.body.byteLength > this.env.maxJsonBytes) {
      throw new PwsError('payload-too-large', 'The request body is too large.');
    }

    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.req.body)) as unknown;
    } catch {
      throw invalidBody('The request body is not valid JSON.');
    }
  }

  jsonObjectBody(): JsonObject {
    const value = this.jsonBody();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw invalidBody('The request body must be a JSON object.');
    }

    return value as JsonObject;
  }

  // --- preconditions -------------------------------------------------------------------------

  /**
   * Evaluates `If-Match` / `If-None-Match` against the target's current tag. Call it after
   * authorization. Returns `proceed`, or `not-modified` (a GET/HEAD to answer with 304); a failed
   * precondition throws `precondition-failed`.
   */
  precondition(currentEtag: string | undefined): Exclude<Precondition, 'precondition-failed'> {
    const result = evaluatePreconditions({
      method: this.method,
      ifMatch: this.header('if-match'),
      ifNoneMatch: this.header('if-none-match'),
      currentEtag,
    });
    if (result === 'precondition-failed') {
      throw new PwsError('precondition-failed', 'The precondition of the request was not met.');
    }

    return result;
  }

  // --- authorization -------------------------------------------------------------------------

  accessEnv(scopeUrl: string, rootController: string): AccessEnv {
    return {
      scopeUrl,
      rootController,
      // The URL as the router and the signature layer read it (dot segments resolved), never the raw string.
      requestTarget: this.url.href,
      method: this.method,
      keys: this.env.keys,
      now: this.now,
      skewSeconds: this.env.skewSeconds,
      maxChainLength: this.env.maxChainLength,
      ...(this.env.isRevoked ? { isRevoked: this.env.isRevoked } : {}),
    };
  }

  /** Whether the effective policy (most specific wins) makes the target publicly readable. */
  async publiclyReadable(chain: readonly PolicyScope[] | undefined): Promise<boolean> {
    if (chain === undefined) {
      return false;
    }

    for (const scope of chain) {
      const policy = await this.tx.getPolicy(scope);
      if (policy !== undefined) {
        return policyGrantsRead(policy);
      }
    }

    return false;
  }

  /**
   * Authorizes the request against `spaceUrl`'s roots (controlled by `rootController`), under
   * `rule`, with `policyChain` as the policy lookup order (most specific first) or undefined when
   * no policy may apply. Throws the right refusal, so a caller that returns has been allowed.
   */
  async authorize(options: {
    spaceUrl: string;
    rootController: string;
    rule?: CapabilityRule;
    policyChain?: readonly PolicyScope[];
  }): Promise<{ via: 'root' | 'delegated' | 'policy'; invoker?: string }> {
    const decision = await decide({
      authn: this.authn,
      env: this.accessEnv(options.spaceUrl, options.rootController),
      rule: options.rule ?? { kind: 'any' },
      policyRead: () => this.publiclyReadable(options.policyChain),
    });
    if (decision.ok) {
      return { via: decision.via, ...(decision.invoker ? { invoker: decision.invoker } : {}) };
    }

    throw refusal(decision);
  }
}

/** The policy lookup order for a target, most specific first. */
export function policyChain(spaceId: string, collectionId?: string, resourceId?: string): PolicyScope[] {
  return [
    ...(collectionId !== undefined && resourceId !== undefined
      ? [{ spaceId, collectionId, resourceId }]
      : []),
    ...(collectionId !== undefined ? [{ spaceId, collectionId }] : []),
    { spaceId },
  ];
}
