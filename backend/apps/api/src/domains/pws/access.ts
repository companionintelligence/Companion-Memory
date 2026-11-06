/**
 * Access decisions: whether the request in hand is allowed to act on its target.
 *
 * The order is the specification's ("Capability first, policy second"): the capability the request
 * invokes is checked first; only if it does not authorize, and only for a read, is the effective
 * access control policy consulted. A policy never denies someone who holds a valid capability, and
 * an absent or unrecognized policy grants nothing.
 *
 * The container rule (PWS Authorization, "The container rule"): a capability for a container's URL
 * covers everything beneath it, so nothing about the target tells "delete this container" from
 * "delete a Resource inside it". Four operations are therefore controller-only, authorized by a
 * root capability the controller invokes directly, and delegation is refused outright for them,
 * whatever the grant says. The two named exceptions are expressed as predicates a caller passes:
 *
 *   Delete Space              also: a delegated capability targeting exactly the Space URL whose
 *                             `allowedAction` is exactly ['DELETE']
 *   Update/Create Collection  also: a delegated capability targeting exactly the Space URL, or
 *                             exactly the Collection URL (see `docs/pws.md`: the specification text
 *                             names only the Space URL; the conformance suite and the reference
 *                             server also accept the Collection's own URL, and so does this)
 *
 * Refusals are the masked `not-found`. An anonymous write is answered `401` by the handler before any
 * state is read, so it never reaches a decision: that answer is the same for every target and tells the
 * caller to authenticate without telling it what exists.
 */
import type { Authn } from './authn';
import { PwsError, notFound } from './problems';
import type { PolicyDocument } from './models';
import { authorizeInvocation, parseRootZcapId, ZCAP_CONTEXT } from './zcap';
import type { ChainContext, DelegatedZcap, DenialReason, RootZcap, Zcap } from './zcap';

/** The access control policy types this server evaluates (Policy Type Registry). */
export const POLICY_TYPES = ['PublicCanRead'] as const;

export function isRecognizedPolicy(policy: PolicyDocument | undefined): boolean {
  return policy !== undefined && (POLICY_TYPES as readonly string[]).includes(policy.type);
}

export function policyGrantsRead(policy: PolicyDocument | undefined): boolean {
  return policy?.type === 'PublicCanRead';
}

/** Which capabilities may authorize an operation. */
export type CapabilityRule =
  /** Any capability that covers the target and allows the action. */
  | { kind: 'any' }
  /** Only a root capability invoked directly by the controller. */
  | { kind: 'root' }
  /** A root capability, or a delegated one the predicate accepts (a container-rule exception). */
  | { kind: 'root-or'; delegated: (tail: DelegatedZcap) => boolean };

export interface AccessEnv extends Omit<ChainContext, 'rootCapability'> {
  /** The URL (ending in `/`) every acceptable root capability's target must be at or below. */
  scopeUrl: string;
  /** The DID that controls the roots this server mints for the request. */
  rootController: string;
  /** The request URL, query included: the invocation target. */
  requestTarget: string;
  /** The HTTP method. Only `GET` and `HEAD` are reads a policy may authorize. */
  method: string;
}

export type Decision =
  | { ok: true; via: 'root' | 'delegated' | 'policy'; invoker?: string }
  | { ok: false; reason?: DenialReason; detail?: string };

export interface DecideInput {
  authn: Authn;
  env: AccessEnv;
  rule: CapabilityRule;
  /** Whether a policy that grants `read` may authorize this request (reads only, never writes). */
  policyRead: () => Promise<boolean>;
}

function mintedRoot(env: AccessEnv): (id: string) => RootZcap | undefined {
  return (id) => {
    const target = parseRootZcapId(id);
    // A root names a target at or below the scope; one for the whole origin is no root of ours.
    if (target === undefined || !target.startsWith(env.scopeUrl)) {
      return undefined;
    }
    return { '@context': ZCAP_CONTEXT, id, controller: env.rootController, invocationTarget: target };
  };
}

function exactlyDelete(tail: Zcap): boolean {
  const actions =
    'allowedAction' in tail && tail.allowedAction !== undefined ? [tail.allowedAction].flat() : [];
  return actions.length === 1 && actions[0] === 'DELETE';
}

/** Delete Space: the exact Space URL with `allowedAction` exactly `['DELETE']`. */
export function deleteSpaceException(spaceUrl: string): (tail: DelegatedZcap) => boolean {
  return (tail) => tail.invocationTarget === spaceUrl && exactlyDelete(tail);
}

/** Update/Create Collection: a grant targeting exactly the Space URL, or exactly the Collection URL. */
export function collectionMetaException(
  spaceUrl: string,
  collectionUrl: string,
): (tail: DelegatedZcap) => boolean {
  return (tail) => tail.invocationTarget === spaceUrl || tail.invocationTarget === collectionUrl;
}

export async function decide({ authn, env, rule, policyRead }: DecideInput): Promise<Decision> {
  let reason: DenialReason | undefined;
  let detail: string | undefined;

  if (authn.kind === 'signed') {
    const result = await authorizeInvocation(
      {
        parsed: authn.parsed,
        invoker: authn.invoker,
        signatureCreated: authn.created,
        requestTarget: env.requestTarget,
        action: authn.parsed.action,
      },
      { ...env, rootCapability: mintedRoot(env) },
    );
    if (result.ok) {
      const permitted =
        result.via === 'root' ||
        rule.kind === 'any' ||
        (rule.kind === 'root-or' && rule.delegated(result.capability as DelegatedZcap));
      if (permitted) {
        return { ok: true, via: result.via, invoker: authn.invoker.did };
      }
      reason = 'invoker-not-controller';
      detail = 'This operation is reserved to the Space controller.';
    } else {
      ({ reason, detail } = result);
    }
  }

  // A policy only ever broadens access, and only to reads. It is consulted whatever became of the
  // capability, so a GET carrying a capability that does not authorize still reads a public resource.
  if ((env.method === 'GET' || env.method === 'HEAD') && (await policyRead())) {
    return { ok: true, via: 'policy' };
  }
  return { ok: false, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) };
}

/**
 * The error for a refused decision: the masked `not-found`, with one exception. A capability that
 * `authorizeInvocation` found expired only after everything else about it and its invoker checked out is
 * named `capability-expired` (still `404`): that caller holds the grant and its key, and learns only about
 * its own grant. That holds only while every caller authorizes BEFORE it looks up anything beneath the Space
 * (a Collection, a Resource): the answer must not depend on whether the thing exists. An anonymous write
 * never gets here (the handler answers it `401` before any state is read), and a policy only ever
 * broadens reads.
 */
export function refusal(decision?: { reason?: DenialReason }): PwsError {
  return decision?.reason === 'expired'
    ? new PwsError('capability-expired', 'The invoked capability, or one in its chain, has expired.')
    : notFound();
}
