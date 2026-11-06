/**
 * A PWS client in miniature, plus a world to point it at: identities, signed requests, delegations,
 * and a handler over an in-memory store with a clock the tests can move.
 *
 * It is built from this domain's own primitives, so it proves the handler against *this* code's
 * reading of the wire format. What ties that reading to other implementations is not here: it is
 * `referenceVectors.ts` (the specification's printed worked example and the reference stack's
 * output), and the conformance run described in `docs/pws.md`.
 */
import { didKeyFromPublicKey, keyIdFromDidKey } from '../didKey';
import { LocalEd25519Signer, publicKeyFromSeed } from '../ed25519';
import { createPwsHandler } from '../handler';
import type { PwsConfig, PwsHandler } from '../handler';
import { signRequest } from '../httpSignature';
import type { PwsResponse } from '../http';
import { MemoryPwsStore } from '../store';
import { delegateCapability, formatCapabilityInvocation, rootZcapId } from '../zcap';
import type { DelegatedZcap } from '../zcap';

export const ORIGIN = 'https://example.com';
export const T0 = new Date('2026-11-05T12:00:00.000Z');

export interface Identity {
  did: string;
  keyId: string;
  signer: LocalEd25519Signer;
}

/** A deterministic test identity: the seed is `byte` repeated 32 times. Never authorize one anywhere real. */
export function identity(byte: number): Identity {
  const seed = new Uint8Array(32).fill(byte);
  const did = didKeyFromPublicKey(publicKeyFromSeed(seed));
  const keyId = keyIdFromDidKey(did);
  return { did, keyId, signer: new LocalEd25519Signer(keyId, seed) };
}

export const alice = identity(0x11);
export const bob = identity(0x22);
export const app = identity(0x33);
export const carol = identity(0x44);

export interface Send {
  method: string;
  /** Relative to the server root, with any query: `space/s/c/?limit=2`. */
  path: string;
  as?: Identity;
  json?: unknown;
  body?: Uint8Array | string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Invoke this delegated capability instead of a root. */
  via?: DelegatedZcap;
  /** The target of the root capability to invoke (default: the request URL, as ezcap does). */
  root?: string;
  /** Override the invoked action (default: the method). */
  action?: string;
  /** Signature `created`, in seconds (default: the world's clock). */
  created?: number;
  expires?: number;
  /** Send this body although the signature covers a different one. */
  tamperedBody?: Uint8Array | string;
  /** Drop a header after signing. */
  strip?: string[];
  /** Attach a body after signing, covered by neither a Content-Type nor a Digest. */
  unsignedBody?: string;
}

export class TestResponse {
  constructor(readonly raw: PwsResponse) {}

  get status(): number {
    return this.raw.status;
  }

  header(name: string): string | undefined {
    return this.raw.headers[name.toLowerCase()];
  }

  get text(): string {
    return this.raw.body ? new TextDecoder().decode(this.raw.body) : '';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get json(): any {
    return JSON.parse(this.text);
  }

  get type(): string | undefined {
    return this.raw.status >= 400 && this.raw.headers['content-type']?.startsWith('application/problem+json')
      ? (this.json as { type?: string }).type?.replace('https://w3id.org/pws#', '')
      : undefined;
  }
}

const bytesOf = (value: Uint8Array | string): Uint8Array =>
  typeof value === 'string' ? new TextEncoder().encode(value) : value;

export class World {
  readonly store = new MemoryPwsStore();
  now = new Date(T0);
  readonly handler: PwsHandler;
  private counter = 0;

  constructor(config: Partial<PwsConfig> = {}) {
    this.handler = createPwsHandler({
      baseUrl: `${ORIGIN}/`,
      store: this.store,
      now: () => this.now,
      generateId: () => `gen-${++this.counter}`,
      originId: 'test-origin',
      ...config,
    });
  }

  url(path: string): string {
    return `${ORIGIN}/${path}`;
  }

  advance(seconds: number): void {
    this.now = new Date(this.now.getTime() + seconds * 1000);
  }

  iso(offsetSeconds = 0): string {
    return new Date(this.now.getTime() + offsetSeconds * 1000).toISOString().replace('.000Z', 'Z');
  }

  async send(args: Send): Promise<TestResponse> {
    const url = this.url(args.path);
    const body =
      args.json !== undefined
        ? bytesOf(JSON.stringify(args.json))
        : args.body !== undefined
          ? bytesOf(args.body)
          : undefined;
    const contentType =
      args.contentType ??
      (args.json !== undefined ? 'application/json' : body ? 'application/octet-stream' : undefined);
    let headers: Record<string, string> = {
      ...(contentType && body ? { 'content-type': contentType } : {}),
      ...args.headers,
    };

    if (args.as) {
      const action = args.action ?? args.method;
      const capabilityInvocation = args.via
        ? formatCapabilityInvocation({ capability: args.via, action })
        : formatCapabilityInvocation({ rootId: rootZcapId(args.root ?? url), action });
      headers = await signRequest({
        method: args.method,
        url,
        headers,
        ...(body ? { body } : {}),
        signer: args.as.signer,
        created: args.created ?? Math.floor(this.now.getTime() / 1000),
        ...(args.expires !== undefined ? { expires: args.expires } : {}),
        capabilityInvocation,
      });
    } else if (!headers.host) {
      headers.host = new URL(url).host;
    }
    for (const name of args.strip ?? []) {
      delete headers[name];
    }
    const sent =
      args.tamperedBody !== undefined
        ? bytesOf(args.tamperedBody)
        : args.unsignedBody !== undefined
          ? bytesOf(args.unsignedBody)
          : body;
    return new TestResponse(
      await this.handler.handle({ method: args.method, url, headers, ...(sent ? { body: sent } : {}) }),
    );
  }

  // --- conveniences ---------------------------------------------------------------------------

  spaceUrl(spaceId: string): string {
    return this.url(`space/${spaceId}/`);
  }

  async createSpace(as: Identity, spaceId: string, extra: Record<string, unknown> = {}): Promise<void> {
    const res = await this.send({
      method: 'POST',
      path: 'spaces/',
      as,
      json: { id: spaceId, name: spaceId, controller: as.did, ...extra },
    });
    if (res.status !== 201) {
      throw new Error(`createSpace failed: ${res.status} ${res.text}`);
    }
  }

  async createCollection(
    as: Identity,
    spaceId: string,
    collectionId: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const res = await this.send({
      method: 'POST',
      path: `space/${spaceId}/`,
      as,
      root: this.spaceUrl(spaceId),
      json: { id: collectionId, name: collectionId, ...extra },
    });
    if (res.status !== 201) {
      throw new Error(`createCollection failed: ${res.status} ${res.text}`);
    }
  }

  async putResource(
    as: Identity,
    spaceId: string,
    collectionId: string,
    resourceId: string,
    json: unknown,
  ): Promise<TestResponse> {
    return this.send({
      method: 'PUT',
      path: `space/${spaceId}/${collectionId}/${resourceId}`,
      as,
      root: this.spaceUrl(spaceId),
      json,
    });
  }

  /** Alice's usual authority: a root capability for the whole Space. */
  asController(as: Identity, spaceId: string): { as: Identity; root: string } {
    return { as, root: this.spaceUrl(spaceId) };
  }

  async delegate(args: {
    from: Identity;
    to: Identity;
    /** The Space whose root capability is the parent (unless `rootTarget` or `parent` says otherwise). */
    spaceId?: string;
    /** Delegate from the root capability of this target instead of a Space's. */
    rootTarget?: string;
    target: string;
    actions?: string[];
    parent?: DelegatedZcap;
    expiresInSeconds?: number;
    id?: string;
  }): Promise<DelegatedZcap> {
    return delegateCapability({
      parent: args.parent ?? rootZcapId(args.rootTarget ?? this.spaceUrl(args.spaceId ?? '')),
      signer: args.from.signer,
      controller: args.to.did,
      invocationTarget: args.target,
      ...(args.actions ? { allowedAction: args.actions } : {}),
      expires: this.iso(args.expiresInSeconds ?? 365 * 24 * 3600),
      created: this.iso(),
      ...(args.id ? { id: args.id } : {}),
    });
  }
}
