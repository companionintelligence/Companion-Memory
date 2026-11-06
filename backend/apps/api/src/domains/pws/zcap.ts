/**
 * Authorization capabilities (zCaps) as the PWS Authorization Profile uses them: the implied root
 * capability of a target, delegation by `eddsa-jcs-2022` Data Integrity proofs, and the checks a
 * server runs before it honours an invocation.
 *
 * Wire shapes follow the ZCAP specification and the deployed reference stack:
 *
 *   root           { "@context": zcap/v1, id: "urn:zcap:root:" + encodeURIComponent(target),
 *                    controller, invocationTarget }      never sent; each server mints its own
 *   delegated      { "@context": [zcap/v1, ...], id, parentCapability, invocationTarget,
 *                    controller, expires, allowedAction?, proof }
 *   delegation     proof.proofPurpose "capabilityDelegation", proof.capabilityChain
 *   chain          [rootId, id, ..., idOfGrandparent, parentCapabilityEmbeddedInFull]
 *
 * Target attenuation is by URL prefix: a capability for `.../space/s/` covers everything under it.
 * Every delegated capability must expire. Trust starts at the root and moves toward the tail, so a
 * long chain of junk is rejected before any signature is checked.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

import { createEddsaJcs2022Proof, verifyEddsaJcs2022Proof } from './dataIntegrity';
import type { DataIntegrityProof, JsonObject, JsonValue } from './dataIntegrity';
import type { Signer } from './ed25519';
import { didOf } from './keys';
import type { DidRegistry } from './keys';
import { base64urlDecode } from './multibase';

export const ZCAP_CONTEXT = 'https://w3id.org/zcap/v1';
export const ROOT_PREFIX = 'urn:zcap:root:';
export const DEFAULT_MAX_CHAIN_LENGTH = 10;
/** Cap on the inflated size of a capability carried in a header (a decompression-bomb guard). */
export const MAX_EMBEDDED_CAPABILITY_BYTES = 256 * 1024;

export interface RootZcap {
  '@context': string;
  id: string;
  controller: string;
  invocationTarget: string;
}

/** A `DataIntegrityProof` whose purpose is delegation. Not an extension of the generic proof: its chain embeds capabilities. */
export interface DelegationProof {
  type: 'DataIntegrityProof';
  cryptosuite: 'eddsa-jcs-2022';
  verificationMethod: string;
  created: string;
  proofPurpose: 'capabilityDelegation';
  proofValue: string;
  capabilityChain: Array<string | DelegatedZcap>;
  '@context'?: JsonValue;
}

export interface DelegatedZcap {
  '@context': string[];
  id: string;
  parentCapability: string;
  invocationTarget: string;
  controller: string;
  expires: string;
  allowedAction?: string | string[];
  proof: DelegationProof;
}

export type Zcap = RootZcap | DelegatedZcap;

// --- identifiers -----------------------------------------------------------------------------

export function rootZcapId(target: string): string {
  return `${ROOT_PREFIX}${encodeURIComponent(target)}`;
}

/**
 * The target a root capability id names, or undefined when the id is not exactly
 * `urn:zcap:root:` + `encodeURIComponent(an absolute http(s) URL)`. Strict, so a root has one spelling.
 */
export function parseRootZcapId(id: string): string | undefined {
  if (!id.startsWith(ROOT_PREFIX)) {
    return undefined;
  }
  const encoded = id.slice(ROOT_PREFIX.length);
  let target: string;
  try {
    target = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (encodeURIComponent(target) !== encoded) {
    return undefined;
  }
  try {
    const url = new URL(target);
    return url.protocol === 'https:' || url.protocol === 'http:' ? target : undefined;
  } catch {
    return undefined;
  }
}

function isAbsoluteUri(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  );
}

// --- attenuation -----------------------------------------------------------------------------

/**
 * Whether `target` is `base` or a path/query extension of it. A base that already ends in `/`,
 * `?` or `&` is its own boundary, so `/space/abc/` never covers `/space/abc-evil` and the
 * slashless `/space/abc` never covers `/space/abc/` siblings by accident.
 */
export function isValidTarget(target: string, base: string): boolean {
  if (target === base) {
    return true;
  }
  const prefixes: string[] = [];
  if (base.includes('?')) {
    prefixes.push(base.endsWith('?') || base.endsWith('&') ? base : `${base}&`);
  } else {
    prefixes.push(base.endsWith('/') ? base : `${base}/`);
    prefixes.push(`${base}?`);
  }
  return prefixes.some((prefix) => target.startsWith(prefix));
}

export function allowedActions(zcap: Zcap): string[] | undefined {
  if (!('allowedAction' in zcap) || zcap.allowedAction === undefined) {
    return undefined;
  }
  return [zcap.allowedAction].flat();
}

/** A child may only narrow its parent's actions; a parent without the field allows any. */
export function actionsAttenuate(child: string[] | undefined, parent: string[] | undefined): boolean {
  if (parent === undefined) {
    return true;
  }
  return child !== undefined && child.every((action) => parent.includes(action));
}

function controllersOf(zcap: Zcap): string[] {
  return [zcap.controller].flat();
}

/** The invoker (or delegator) is a controller when the capability names its DID or its key id. */
function isController(zcap: Zcap, did: string, keyId: string): boolean {
  const controllers = controllersOf(zcap);
  return controllers.includes(did) || controllers.includes(keyId);
}

// --- shape checks ----------------------------------------------------------------------------

export class ZcapError extends Error {
  constructor(
    readonly reason: DenialReason,
    message: string,
  ) {
    super(message);
    this.name = 'ZcapError';
  }
}

export type DenialReason =
  | 'malformed'
  | 'root-not-accepted'
  | 'delegator-not-controller'
  | 'bad-proof'
  | 'expired'
  | 'revoked'
  | 'attenuation'
  | 'too-long'
  | 'target-mismatch'
  | 'action-not-allowed'
  | 'invoker-not-controller'
  | 'invoked-before-delegation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * An RFC 3339 date-time as epoch milliseconds, or undefined. Stricter than `Date.parse`, which
 * rolls an impossible day forward (`2027-02-30` becomes March 2) and would let a malformed
 * `expires` pass for a real one.
 */
export function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = RFC3339.exec(value);
  if (!match) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const probe = new Date(utc);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return undefined;
  }
  let offsetMinutes = 0;
  if (match[8] !== undefined) {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (offsetHour > 23 || offsetMinute > 59) {
      return undefined;
    }
    offsetMinutes = (match[8] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  const fraction = match[7] !== undefined ? Math.floor(Number(`0${match[7]}`) * 1000) : 0;
  return utc + fraction - offsetMinutes * 60_000;
}

/**
 * Structural validation of an untrusted delegated capability (ZCAP data model). Throws a
 * `ZcapError('malformed')`; returns the same object, typed, when it is well formed.
 */
export function checkDelegatedZcap(value: unknown): DelegatedZcap {
  const fail = (message: string): never => {
    throw new ZcapError('malformed', message);
  };
  if (!isRecord(value)) {
    return fail('a capability must be an object');
  }
  const context = value['@context'];
  if (!Array.isArray(context) || context[0] !== ZCAP_CONTEXT) {
    return fail(`a delegated capability's "@context" must be an array starting with ${ZCAP_CONTEXT}`);
  }
  if (!isAbsoluteUri(value.id)) {
    return fail('"id" must be an absolute URI');
  }
  if (!isAbsoluteUri(value.parentCapability)) {
    return fail('"parentCapability" must be an absolute URI');
  }
  if (!isAbsoluteUri(value.invocationTarget)) {
    return fail('"invocationTarget" must be an absolute URI');
  }
  const controller = value.controller;
  if (typeof controller !== 'string' || controller.length === 0) {
    return fail('"controller" must be a DID string');
  }
  if (parseTime(value.expires) === undefined) {
    return fail('a delegated capability must have a valid "expires" date-time');
  }
  const action = value.allowedAction;
  if (
    action !== undefined &&
    !(
      typeof action === 'string' ||
      (Array.isArray(action) && action.length > 0 && action.every((a) => typeof a === 'string'))
    )
  ) {
    return fail('"allowedAction" must be a string or a non-empty array of strings');
  }
  const proof = value.proof;
  if (!isRecord(proof)) {
    return fail('a delegated capability must have exactly one "proof" object');
  }
  if (proof.proofPurpose !== 'capabilityDelegation') {
    return fail('the proof must have proofPurpose "capabilityDelegation"');
  }
  if (proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022') {
    return fail('only eddsa-jcs-2022 delegation proofs are accepted');
  }
  if (typeof proof.verificationMethod !== 'string' || typeof proof.proofValue !== 'string') {
    return fail('the proof must carry a verificationMethod and a proofValue');
  }
  if (parseTime(proof.created) === undefined) {
    return fail('the proof must carry a valid "created" date-time');
  }
  if (
    !Array.isArray(proof.capabilityChain) ||
    proof.capabilityChain.length < 1 ||
    !proof.capabilityChain.every((entry: unknown) => typeof entry === 'string' || isRecord(entry))
  ) {
    return fail('the proof must carry a non-empty "capabilityChain" of capability ids and capabilities');
  }
  return value as unknown as DelegatedZcap;
}

// --- header codecs ---------------------------------------------------------------------------

/** Decodes the `capability` parameter of a `Capability-Invocation` header: `base64url(gzip(json))`. */
export function decodeEmbeddedCapability(encoded: string): unknown {
  try {
    const compressed = base64urlDecode(encoded);
    const json = gunzipSync(compressed, { maxOutputLength: MAX_EMBEDDED_CAPABILITY_BYTES }).toString('utf8');
    return JSON.parse(json);
  } catch {
    throw new ZcapError(
      'malformed',
      'the capability in the Capability-Invocation header is improperly encoded',
    );
  }
}

/**
 * The `Capability-Invocation` header value a client sends: `zcap id="..."` for a root capability
 * (its id and nothing else) or `zcap capability="..."` for a delegated one (`base64url(gzip(json))`).
 */
export function formatCapabilityInvocation(
  args: { rootId: string; action: string } | { capability: DelegatedZcap; action: string },
): string {
  if ('rootId' in args) {
    return `zcap id="${args.rootId}",action="${args.action}"`;
  }
  const encoded = gzipSync(Buffer.from(JSON.stringify(args.capability), 'utf8')).toString('base64url');
  return `zcap capability="${encoded}",action="${args.action}"`;
}

export interface ParsedCapabilityInvocation {
  /** Present when a root capability is invoked: its id, and only its id. */
  rootId?: string;
  /** Present when a delegated capability is invoked: the decoded (still untrusted) capability. */
  capability?: unknown;
  action: string;
}

const INVOCATION_PARAMS = /^([A-Za-z]+)="([^"]*)"$/;

/**
 * Splits `text` at the commas outside double quotes, in one pass. (The lookahead split this replaces rescanned
 * the rest of the header at every comma: quadratic, about 250 ms for a 15 kB header, and reachable by anyone
 * with a self-made `did:key`.) An odd number of quotes still ends in `malformed`: the parts cannot then all
 * hold the two quotes each that `INVOCATION_PARAMS` requires.
 */
function splitOutsideQuotes(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x22) {
      quoted = !quoted;
    } else if (code === 0x2c && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Parses `zcap id="...",action="GET"` and `zcap capability="...",action="GET"`. */
export function parseCapabilityInvocation(value: string): ParsedCapabilityInvocation {
  const trimmed = value.trim();
  if (!trimmed.startsWith('zcap ')) {
    throw new ZcapError('malformed', 'the Capability-Invocation scheme must be "zcap"');
  }
  const params = new Map<string, string>();
  for (const part of splitOutsideQuotes(trimmed.slice(5))) {
    const match = INVOCATION_PARAMS.exec(part.trim());
    if (!match || params.has(match[1] as string)) {
      throw new ZcapError('malformed', 'the Capability-Invocation header is malformed');
    }
    params.set(match[1] as string, match[2] as string);
  }
  for (const name of params.keys()) {
    if (name !== 'id' && name !== 'capability' && name !== 'action') {
      throw new ZcapError('malformed', `unknown Capability-Invocation parameter "${name}"`);
    }
  }
  const action = params.get('action');
  const id = params.get('id');
  const capability = params.get('capability');
  if (!action) {
    throw new ZcapError('malformed', 'the Capability-Invocation header must carry an "action"');
  }
  if ((id === undefined) === (capability === undefined)) {
    throw new ZcapError(
      'malformed',
      'the Capability-Invocation header must carry exactly one of "id" and "capability"',
    );
  }
  return id !== undefined
    ? { rootId: id, action }
    : { capability: decodeEmbeddedCapability(capability as string), action };
}

// --- verification ----------------------------------------------------------------------------

export interface ChainContext {
  /** The trusted root capability for `id`, or undefined when this server does not mint it. */
  rootCapability(id: string): RootZcap | undefined;
  keys: DidRegistry;
  now: Date;
  skewSeconds: number;
  maxChainLength: number;
  /** Optional revocation hook: whether a delegated capability has been withdrawn. */
  isRevoked?(capabilityId: string): Promise<boolean>;
}

export type ChainResult =
  { ok: true; chain: [RootZcap, ...DelegatedZcap[]] } | { ok: false; reason: DenialReason; detail: string };

function deny(reason: DenialReason, detail: string): { ok: false; reason: DenialReason; detail: string } {
  return { ok: false, reason, detail };
}

function chainId(entry: string | DelegatedZcap): string {
  return typeof entry === 'string' ? entry : entry.id;
}

/**
 * Dereferences a delegated capability's chain into `[root, ...delegated]`, root first. The chain
 * of each capability must be exactly its parent's chain extended by the parent; every entry but
 * the last is an id, and the last (when there is more than the root) is the parent in full.
 */
function dereference(
  tail: DelegatedZcap,
  ctx: ChainContext,
): { ok: true; ordered: DelegatedZcap[]; rootId: string } | ReturnType<typeof deny> {
  if (tail.proof.capabilityChain.length + 1 > ctx.maxChainLength) {
    return deny('too-long', `the capability chain exceeds the maximum length of ${ctx.maxChainLength}`);
  }
  const ordered: DelegatedZcap[] = [tail];
  let current = tail;
  let required = current.proof.capabilityChain.length;
  for (;;) {
    const chain = current.proof.capabilityChain;
    if (chain.length !== required) {
      return deny('malformed', 'the capability chain length is incongruent');
    }
    const last = chain[chain.length - 1] as string | DelegatedZcap;
    for (const [index, entry] of chain.entries()) {
      const isLast = index === chain.length - 1;
      const wantObject = isLast && chain.length > 1;
      if (wantObject ? !isRecord(entry) : typeof entry !== 'string') {
        return deny(
          'malformed',
          'the capability chain must be ids, ending in the embedded parent when delegated',
        );
      }
      const id = chainId(entry);
      if (!isAbsoluteUri(id)) {
        return deny('malformed', 'the capability chain holds an id that is not an absolute URI');
      }
    }
    if (chainId(last) !== current.parentCapability) {
      return deny('malformed', 'the last entry of the capability chain is not the parent capability');
    }
    if (chain.length === 1) {
      const rootId = chain[0] as string;
      const ids = [rootId, ...ordered.map((zcap) => zcap.id)];
      if (new Set(ids).size !== ids.length) {
        return deny('malformed', 'the capability chain contains a cycle');
      }
      return { ok: true, ordered, rootId };
    }
    let parent: DelegatedZcap;
    try {
      parent = checkDelegatedZcap(last);
    } catch (error) {
      return deny('malformed', error instanceof Error ? error.message : 'malformed capability');
    }
    const expectedIds = chain.slice(0, -1).map(chainId);
    const parentIds = parent.proof.capabilityChain.map(chainId);
    if (parentIds.length !== expectedIds.length || parentIds.some((id, index) => id !== expectedIds[index])) {
      return deny('malformed', 'the capability chain is inconsistent across delegated capabilities');
    }
    ordered.unshift(parent);
    current = parent;
    required -= 1;
  }
}

function withinSkew(now: number, deadline: number, skewSeconds: number): boolean {
  return now <= deadline + skewSeconds * 1000;
}

/**
 * Verifies a delegated capability's whole chain, root first: the root is one this server mints,
 * every delegation was signed by the previous capability's controller with a key that is listed
 * for delegation in its DID document today, no link widens its parent, nothing has expired, and
 * a link was not delegated before its parent was.
 *
 * Expiry is judged last: the whole chain is verified first, so a chain is reported `expired` only if
 * every proof in it checked out (see `authorizeInvocation`, which judges it after the invoker too).
 */
export async function verifyDelegationChain(tail: DelegatedZcap, ctx: ChainContext): Promise<ChainResult> {
  const dereferenced = dereference(tail, ctx);
  if (!dereferenced.ok) {
    return dereferenced;
  }
  const root = ctx.rootCapability(dereferenced.rootId);
  if (!root) {
    return deny('root-not-accepted', 'the root capability of the chain is not one this server accepts here');
  }

  const now = ctx.now.getTime();
  let parent: Zcap = root;
  let parentExpires: number | undefined;
  let parentDelegated: number | undefined;
  let expired: string | undefined;
  for (const zcap of dereferenced.ordered) {
    const { proof } = zcap;

    // 1. Who signed: the parent's controller, with a key authorized to delegate today.
    const key = await ctx.keys.resolveKey(proof.verificationMethod, 'capabilityDelegation');
    if (!key) {
      return deny(
        'bad-proof',
        'a delegation proof names a key that does not resolve for capability delegation',
      );
    }
    if (!isController(parent, key.did, proof.verificationMethod)) {
      return deny(
        'delegator-not-controller',
        'a delegation was signed by a DID that does not control its parent capability',
      );
    }

    // 2. The proof itself.
    const { proof: _proof, ...document } = zcap;
    if (
      !verifyEddsaJcs2022Proof({
        document: document as unknown as JsonObject,
        proof: proof as unknown as DataIntegrityProof,
        publicKey: key.publicKey,
      })
    ) {
      return deny('bad-proof', 'a delegation proof failed verification');
    }

    // 3. Attenuation, expiry, ordering.
    if (!actionsAttenuate(allowedActions(zcap), allowedActions(parent))) {
      return deny('attenuation', 'a delegated capability allows an action its parent does not');
    }
    if (!isValidTarget(zcap.invocationTarget, parent.invocationTarget)) {
      return deny('attenuation', 'a delegated capability targets something its parent does not cover');
    }
    const expires = parseTime(zcap.expires) as number;
    if (parentExpires !== undefined && expires > parentExpires) {
      return deny('attenuation', 'a delegated capability outlives its parent');
    }
    if (!withinSkew(now, expires, ctx.skewSeconds)) {
      expired ??= 'a capability in the delegation chain has expired';
    }
    const delegated = parseTime(proof.created) as number;
    if (parentDelegated !== undefined && parentDelegated > delegated) {
      return deny('attenuation', 'a capability was delegated before its parent');
    }
    if (ctx.isRevoked && (await ctx.isRevoked(zcap.id))) {
      return deny('revoked', 'a capability in the delegation chain has been revoked');
    }

    parent = zcap;
    parentExpires = expires;
    parentDelegated = delegated;
  }
  if (expired !== undefined) {
    return deny('expired', expired);
  }
  return { ok: true, chain: [root, ...dereferenced.ordered] };
}

export interface InvocationInput {
  parsed: ParsedCapabilityInvocation;
  /** The invoker: the DID behind the key that signed the request, and that key's DID URL. */
  invoker: { did: string; keyId: string };
  /** The `created` parameter of the request's HTTP signature, in seconds. */
  signatureCreated: number;
  /** The full request URL (with its query): the invocation target. */
  requestTarget: string;
  /** The action invoked (the `Capability-Invocation` header's `action`), already checked against the method. */
  action: string;
}

export type InvocationResult =
  | { ok: true; via: 'root' | 'delegated'; capability: Zcap; chain: Zcap[] }
  | { ok: false; reason: DenialReason; detail: string };

/**
 * Whether a request is authorized by the capability it invokes: the capability exists and is
 * verified, covers the request's target and action, has not expired, and its controller is the key
 * holder that signed the request.
 */
export async function authorizeInvocation(
  input: InvocationInput,
  ctx: ChainContext,
): Promise<InvocationResult> {
  const { parsed, invoker, requestTarget, action } = input;

  if (parsed.rootId !== undefined) {
    const root = ctx.rootCapability(parsed.rootId);
    if (!root) {
      return deny('root-not-accepted', 'the invoked root capability is not one this server accepts here');
    }
    if (!isValidTarget(requestTarget, root.invocationTarget)) {
      return deny('target-mismatch', 'the invoked capability does not cover the request target');
    }
    if (!isController(root, invoker.did, invoker.keyId)) {
      return deny('invoker-not-controller', 'the invoker does not control the invoked capability');
    }
    return { ok: true, via: 'root', capability: root, chain: [root] };
  }

  let tail: DelegatedZcap;
  try {
    tail = checkDelegatedZcap(parsed.capability);
  } catch (error) {
    return deny('malformed', error instanceof Error ? error.message : 'malformed capability');
  }
  const verified = await verifyDelegationChain(tail, ctx);
  // An expired chain has otherwise verified, and is judged after everything about the invoker: only a
  // caller that holds the capability and signed with its key is told that it has expired.
  if (!verified.ok && verified.reason !== 'expired') {
    return verified;
  }
  if (!isValidTarget(requestTarget, tail.invocationTarget)) {
    return deny('target-mismatch', 'the invoked capability does not cover the request target');
  }
  const permitted = allowedActions(tail);
  if (permitted !== undefined && !permitted.includes(action)) {
    return deny('action-not-allowed', `the invoked capability does not allow ${action}`);
  }
  if (!isController(tail, invoker.did, invoker.keyId)) {
    return deny('invoker-not-controller', 'the invoker does not control the invoked capability');
  }
  const delegated = parseTime(tail.proof.created) as number;
  if (input.signatureCreated * 1000 < delegated - ctx.skewSeconds * 1000) {
    return deny('invoked-before-delegation', 'a delegated capability was invoked before it was delegated');
  }
  if (!verified.ok) {
    return verified;
  }
  return { ok: true, via: 'delegated', capability: tail, chain: verified.chain };
}

// --- creating delegations (clients, tests, and the future Companion grant issuer) -------------

export interface DelegateOptions {
  /** A root capability id, or the delegated capability being narrowed further. */
  parent: string | DelegatedZcap;
  /** The delegator's key. Its `id` becomes the proof's `verificationMethod`. */
  signer: Signer;
  /** The DID that may invoke or further delegate the new capability. */
  controller: string;
  invocationTarget: string;
  /** Omit to allow every action the parent allows. */
  allowedAction?: string[];
  /** RFC 3339. Required: a delegated capability that cannot expire is not a capability. */
  expires: string;
  /** When the delegation proof is made (RFC 3339). */
  created: string;
  id?: string;
  context?: string[];
}

/** The chain a child of `parent` carries: the parent's chain with the parent appended in full. */
export function chainFor(parent: string | DelegatedZcap): Array<string | DelegatedZcap> {
  if (typeof parent === 'string') {
    return [parent];
  }
  const chain = parent.proof.capabilityChain;
  const last = chain[chain.length - 1] as string | DelegatedZcap;
  return [...chain.slice(0, -1), chainId(last), parent];
}

export async function delegateCapability(options: DelegateOptions): Promise<DelegatedZcap> {
  const id = options.id ?? `urn:uuid:${crypto.randomUUID()}`;
  const document: JsonObject = {
    '@context': options.context ?? [ZCAP_CONTEXT, 'https://w3id.org/security/data-integrity/v2'],
    id,
    parentCapability: typeof options.parent === 'string' ? options.parent : options.parent.id,
    invocationTarget: options.invocationTarget,
    controller: options.controller,
    expires: options.expires,
    ...(options.allowedAction ? { allowedAction: options.allowedAction } : {}),
  };
  const proof = await createEddsaJcs2022Proof({
    document,
    proofOptions: {
      verificationMethod: options.signer.id,
      created: options.created,
      proofPurpose: 'capabilityDelegation',
      capabilityChain: chainFor(options.parent) as unknown as JsonValue,
    },
    signer: options.signer,
  });
  return {
    ...(document as unknown as Omit<DelegatedZcap, 'proof'>),
    proof: proof as unknown as DelegationProof,
  };
}

export { didOf };
