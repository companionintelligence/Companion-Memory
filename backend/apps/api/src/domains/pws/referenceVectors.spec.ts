import { gunzipSync, gzipSync } from 'node:zlib';

import {
  REFERENCE_STACK_VECTORS,
  type ReferenceIdentity,
  type ReferenceInvocationVector,
  type ReferenceStackVectors,
} from './__tests__/referenceVectors';
import {
  createEddsaJcs2022Proof,
  verifyEddsaJcs2022Proof,
  type DataIntegrityProof,
  type JsonObject,
  type JsonValue,
  type ProofOptions,
} from './dataIntegrity';
import { didKeyFromPublicKey, keyIdFromDidKey, publicKeyFromDidKey } from './didKey';
import { digestHeaderValue } from './digest';
import { LocalEd25519Signer, verifyEd25519 } from './ed25519';
import { buildSigningString, parseAuthorizationSignature, signRequest } from './httpSignature';
import { base64urlDecode, base64urlEncode } from './multibase';

/**
 * How the reference vectors are made (so that they can be remade):
 *
 *   1. In a directory outside this repository, install `@interop/ezcap`, `@interop/ed25519-signature`,
 *      `@interop/ed25519-verification-key`, `@interop/http-signature-zcap-invoke`, `@interop/http-signature-header`
 *      and `@interop/http-digest-header` at the versions named in the vectors, with install scripts disabled.
 *   2. `generate.mjs` derives three identities from the seeds 0x01, 0x02 and 0x03 (32 bytes each) with
 *      `Ed25519VerificationKey.generate({ seed }).didKeySigner()`, replaces `crypto.randomUUID` with a counter, and
 *      builds `new ZcapClient({ SuiteClass: EddsaJcs2022, invocationSigner, delegationSigner })` per identity.
 *   3. It delegates L1 (`alice` -> `appDid`, Space root, GET/HEAD on the collection) and L2 (`appDid` -> `bob`, L1,
 *      GET on the resource) with `ZcapClient.delegate({ now })`, then calls `signCapabilityInvocation` with a fixed
 *      `created` for four requests, and records every header plus the signing string
 *      `@interop/http-signature-header` `createSignatureString` builds for it.
 *   4. `emit-ts.mjs` writes the result between the generated markers of `__tests__/referenceVectors.ts`.
 *
 * Step 4 was done on 2026-11-05. This file also proves the harness against a set built from this repository's own
 * code (a self-consistency check, labelled as such), and leaves a `todo` for a checkout where the generated block
 * has been emptied.
 */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'));
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

/** Re-throws a failure with the vector's label in front, so a loop over vectors still says which one broke. */
async function labelled(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      error.message = `[${label}] ${error.message}`;
    }

    throw error;
  }
}

type Who = 'alice' | 'appDid' | 'bob';
const SIGNERS: readonly Who[] = ['alice', 'appDid', 'bob'];

function signerOf(identity: ReferenceIdentity): LocalEd25519Signer {
  return new LocalEd25519Signer(identity.keyId, fromHex(identity.seedHex));
}

function describeVectors(label: string, load: () => Promise<ReferenceStackVectors>): void {
  describe(label, () => {
    let vectors: ReferenceStackVectors;
    beforeAll(async () => {
      vectors = await load();
    });

    const split = (zcap: Record<string, unknown>): { document: JsonObject; proof: DataIntegrityProof } => {
      const { proof, ...document } = zcap;

      return { document: document as JsonObject, proof: proof as DataIntegrityProof };
    };

    const delegatorOf = (name: 'L1' | 'L2'): ReferenceIdentity =>
      vectors.identities[name === 'L1' ? 'alice' : 'appDid'];

    it('the three identities: did:key, key id and public key agree with the seed', () => {
      for (const name of SIGNERS) {
        const identity = vectors.identities[name];
        const signer = signerOf(identity);

        expect(didKeyFromPublicKey(signer.publicKey)).toBe(identity.did);
        expect(keyIdFromDidKey(identity.did)).toBe(identity.keyId);
        expect(identity.did.endsWith(identity.publicKeyMultibase)).toBe(true);
      }
    });

    it('the body digest matches ours', () => {
      expect(digestHeaderValue(utf8(vectors.digestOfBody.body))).toBe(vectors.digestOfBody.digest);
    });

    it('every invocation: headers, signing string and signature reproduce byte for byte', async () => {
      expect(vectors.invocations.length).toBeGreaterThanOrEqual(3);
      for (const vector of vectors.invocations as ReferenceInvocationVector[]) {
        await labelled(vector.label, async () => {
          const identity = vectors.identities[vector.invoker];
          const sent = await signRequest({
            method: vector.method,
            url: vector.url,
            headers: vector.body === null ? {} : { 'content-type': vector.headers['content-type'] ?? '' },
            ...(vector.body !== null && { body: utf8(vector.body) }),
            signer: signerOf(identity),
            created: vector.created,
            expires: vector.expires,
            capabilityInvocation: vector.headers['capability-invocation'] ?? '',
          });

          expect(sent).toEqual(vector.headers);

          const parsed = parseAuthorizationSignature(vector.headers['authorization'] ?? '');
          expect(parsed.headers).toEqual(vector.coveredHeaders);
          expect(parsed.keyId).toBe(identity.keyId);

          const signingString = buildSigningString({
            headers: parsed.headers,
            keyId: parsed.keyId,
            created: parsed.created,
            expires: parsed.expires,
            method: vector.method,
            url: vector.url,
            requestHeaders: vector.headers,
          });
          expect(signingString).toBe(vector.signingString);
          expect(
            verifyEd25519(publicKeyFromDidKey(identity.did), utf8(signingString), parsed.signature),
          ).toBe(true);
        });
      }
    });

    it('a delegated invocation embeds its capability as base64url(gzip(JSON)); a root one names it by id', async () => {
      for (const vector of vectors.invocations as ReferenceInvocationVector[]) {
        await labelled(vector.label, () => {
          const header = vector.headers['capability-invocation'] ?? '';
          if (vector.capabilityKind === 'delegated') {
            const match = /^zcap capability="([A-Za-z0-9_-]+)",action="([A-Z]+)"$/.exec(header);

            expect(match).not.toBeNull();
            expect(match?.[2]).toBe(vector.method);
            const embedded: unknown = JSON.parse(
              gunzipSync(base64urlDecode(match?.[1] ?? '')).toString('utf8'),
            );
            expect([vectors.delegations.L1, vectors.delegations.L2]).toContainEqual(embedded);
          } else {
            const match = /^zcap id="(urn:zcap:root:[^"]+)",action="([A-Z]+)"$/.exec(header);

            expect(match).not.toBeNull();
            expect(Object.values(vectors.rootCapabilityIds)).toContain(match?.[1]);
          }
        });
      }
    });

    it.each(['L1', 'L2'] as const)(
      'delegation %s: the eddsa-jcs-2022 proof verifies with the delegator’s key',
      (name) => {
        const { document, proof } = split(vectors.delegations[name]);

        expect(
          verifyEddsaJcs2022Proof({ document, proof, publicKey: publicKeyFromDidKey(delegatorOf(name).did) }),
        ).toBe(true);
      },
    );

    it.each(['L1', 'L2'] as const)(
      'delegation %s: our proof reproduces the proofValue byte for byte',
      async (name) => {
        const { document, proof } = split(vectors.delegations[name]);
        const {
          proofValue: _proofValue,
          type: _type,
          cryptosuite: _cryptosuite,
          '@context': _context,
          ...options
        } = proof;

        const ours = await createEddsaJcs2022Proof({
          document,
          proofOptions: options as ProofOptions,
          signer: signerOf(delegatorOf(name)),
        });

        expect(ours).toEqual(proof);
      },
    );

    it('delegation L1: from the Space root capability, so its chain is the root id alone', () => {
      const { document, proof } = split(vectors.delegations.L1);

      expect(document['parentCapability']).toBe(vectors.rootCapabilityIds.space);
      expect(proof['capabilityChain']).toEqual([vectors.rootCapabilityIds.space]);
      expect(proof.proofPurpose).toBe('capabilityDelegation');
      expect(proof.verificationMethod).toBe(vectors.identities.alice.keyId);
    });

    it('delegation L2: from L1, so its chain is the root id and the whole of L1', () => {
      const { document, proof } = split(vectors.delegations.L2);

      expect(document['parentCapability']).toBe(vectors.delegations.L1['id']);
      expect(proof['capabilityChain']).toEqual([vectors.rootCapabilityIds.space, vectors.delegations.L1]);
      expect(proof.verificationMethod).toBe(vectors.identities.appDid.keyId);
    });

    it.each(['L1', 'L2'] as const)(
      'delegation %s: the zcap context comes first and the proof repeats the context',
      (name) => {
        const { document, proof } = split(vectors.delegations[name]);
        const context = document['@context'] as string[];

        expect(context[0]).toBe('https://w3id.org/zcap/v1');
        expect(context.length).toBeGreaterThanOrEqual(2);
        expect(proof['@context']).toEqual(context);
      },
    );
  });
}

/**
 * The self-consistency set: built from this repository's own code, in the same shape the reference stack's
 * generator writes. It proves the harness above is right; it proves nothing about other implementations.
 */
async function buildSelfConsistentVectors(): Promise<ReferenceStackVectors> {
  type Party = { identity: ReferenceIdentity; signer: LocalEd25519Signer };
  const party = (seedByte: number): Party => {
    const seed = new Uint8Array(32).fill(seedByte);
    const did = didKeyFromPublicKey(new LocalEd25519Signer('probe', seed).publicKey);
    const keyId = keyIdFromDidKey(did);

    return {
      identity: {
        seedHex: Buffer.from(seed).toString('hex'),
        did,
        keyId,
        publicKeyMultibase: did.slice('did:key:'.length),
      },
      signer: new LocalEd25519Signer(keyId, seed),
    };
  };

  const alice = party(1);
  const appDid = party(2);
  const bob = party(3);

  const spaceId = '81246131-69a4-45ab-9bff-9c946b59cf2e';
  const spaceUrl = `https://example.com/space/${spaceId}/`;
  const collectionUrl = `${spaceUrl}messages/`;
  const resourceUrl = `${collectionUrl}hello-world`;
  const rootId = (url: string): string => `urn:zcap:root:${encodeURIComponent(url)}`;
  const T0 = 1_793_880_000;
  const context = ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'];

  const delegate = async (args: {
    id: string;
    controller: string;
    parent: string;
    chain: JsonValue[];
    target: string;
    actions: string[];
    expires: string;
    by: Party;
    created: string;
  }): Promise<Record<string, unknown>> => {
    const document: JsonObject = {
      '@context': context,
      id: args.id,
      controller: args.controller,
      parentCapability: args.parent,
      invocationTarget: args.target,
      expires: args.expires,
      allowedAction: args.actions,
    };
    const proof = await createEddsaJcs2022Proof({
      document,
      proofOptions: {
        verificationMethod: args.by.signer.id,
        created: args.created,
        proofPurpose: 'capabilityDelegation',
        capabilityChain: args.chain,
      },
      signer: args.by.signer,
    });

    return { ...document, proof };
  };

  const L1 = await delegate({
    id: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    controller: appDid.identity.did,
    parent: rootId(spaceUrl),
    chain: [rootId(spaceUrl)],
    target: collectionUrl,
    actions: ['GET', 'HEAD'],
    expires: '2027-01-01T00:00:00Z',
    by: alice,
    created: iso(T0 - 3600),
  });
  const L2 = await delegate({
    id: 'urn:uuid:00000000-0000-4000-8000-000000000002',
    controller: bob.identity.did,
    parent: L1['id'] as string,
    chain: [rootId(spaceUrl), L1 as JsonObject],
    target: resourceUrl,
    actions: ['GET'],
    expires: '2026-12-31T00:00:00Z',
    by: appDid,
    created: iso(T0 - 1800),
  });

  const embed = (capability: Record<string, unknown>, action: string): string =>
    `zcap capability="${base64urlEncode(gzipSync(JSON.stringify(capability)))}",action="${action}"`;
  const body = '{"message":"hi"}';

  const invocation = async (args: {
    label: string;
    who: Party;
    invoker: Who;
    method: string;
    url: string;
    capabilityInvocation: string;
    capabilityKind: 'root' | 'delegated';
    body?: string;
    created: number;
  }): Promise<ReferenceInvocationVector> => {
    const headers = await signRequest({
      method: args.method,
      url: args.url,
      headers: args.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(args.body !== undefined && { body: utf8(args.body) }),
      signer: args.who.signer,
      created: args.created,
      capabilityInvocation: args.capabilityInvocation,
    });
    const coveredHeaders = parseAuthorizationSignature(headers['authorization'] ?? '').headers;

    return {
      label: args.label,
      invoker: args.invoker,
      method: args.method,
      url: args.url,
      created: args.created,
      expires: args.created + 600,
      body: args.body ?? null,
      capabilityKind: args.capabilityKind,
      headers,
      coveredHeaders,
      signingString: buildSigningString({
        headers: coveredHeaders,
        keyId: args.who.signer.id,
        created: args.created,
        expires: args.created + 600,
        method: args.method,
        url: args.url,
        requestHeaders: headers,
      }),
    };
  };

  return {
    generatedAt: '2026-11-05',
    packages: { 'self-consistency': 'this repository' },
    identities: { alice: alice.identity, appDid: appDid.identity, bob: bob.identity },
    spaceId,
    spaceUrl,
    collectionUrl,
    resourceUrl,
    rootCapabilityIds: {
      space: rootId(spaceUrl),
      collection: rootId(collectionUrl),
      resource: rootId(resourceUrl),
    },
    clock: { nowSeconds: T0 },
    digestOfBody: { body, digest: digestHeaderValue(utf8(body)) },
    delegations: { L1, L2 },
    invocations: [
      await invocation({
        label: 'GET resource, root capability of the resource URL',
        who: alice,
        invoker: 'alice',
        method: 'GET',
        url: resourceUrl,
        capabilityInvocation: `zcap id="${rootId(resourceUrl)}",action="GET"`,
        capabilityKind: 'root',
        created: T0,
      }),
      await invocation({
        label: 'PUT JSON resource, root capability of the Space URL',
        who: alice,
        invoker: 'alice',
        method: 'PUT',
        url: resourceUrl,
        capabilityInvocation: `zcap id="${rootId(spaceUrl)}",action="PUT"`,
        capabilityKind: 'root',
        body,
        created: T0 + 1,
      }),
      await invocation({
        label: 'GET collection page with a query string, delegated capability L1',
        who: appDid,
        invoker: 'appDid',
        method: 'GET',
        url: `${collectionUrl}?limit=2`,
        capabilityInvocation: embed(L1, 'GET'),
        capabilityKind: 'delegated',
        created: T0 + 2,
      }),
      await invocation({
        label: 'GET resource through the two-link chain L1 -> L2',
        who: bob,
        invoker: 'bob',
        method: 'GET',
        url: resourceUrl,
        capabilityInvocation: embed(L2, 'GET'),
        capabilityKind: 'delegated',
        created: T0 + 3,
      }),
    ],
  };
}

describe('reference vectors', () => {
  describeVectors(
    'harness check on a set built from this repository’s own code (self-consistency, not interoperability)',
    buildSelfConsistentVectors,
  );

  if (REFERENCE_STACK_VECTORS) {
    const vectors = REFERENCE_STACK_VECTORS;
    describeVectors(
      `reference stack (${Object.entries(vectors.packages)
        .map(([name, version]) => `${name}@${version}`)
        .join(', ')})`,
      () => Promise.resolve(vectors),
    );
  } else {
    it.todo(
      'reference-stack vectors: generate them (see the recipe at the top of this file) and fill __tests__/referenceVectors.ts',
    );
  }
});
