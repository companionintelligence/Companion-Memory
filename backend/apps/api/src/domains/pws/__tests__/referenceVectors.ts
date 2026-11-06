/**
 * DATA ONLY. Wire-format vectors that other implementations produced, for the specs next to the primitives.
 *
 * 1. `PWS_AUTHZ_WORKED_EXAMPLE` is the authorized `PUT` printed in the Portable Web Spaces Authorization Profile
 *    ("Request Body Integrity (Digest Header)", https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/),
 *    copied as published on 2026-11-05 from the specification repository (commit ed033eb; the repository carries an
 *    MIT licence, (c) 2026 Digital Credentials Consortium, and the specification text is also published under the
 *    W3C Software and Document License 2023). Its signature is illustrative and does NOT verify (no plausible signing
 *    string reproduces it under the public key inside the `did:key`; 1,727 were tried), so it cannot pin the signing
 *    string. It does pin the grammar and the line layout: the `(key-id)` pseudo-header, the header order and the
 *    `host` / `capability-invocation` / `content-type` / `digest` lines, which `httpSignature.spec.ts` checks.
 *
 * 2. `REFERENCE_STACK_VECTORS` is what the PWS reference stack itself produced for fixed inputs: invocation headers
 *    from `@interop/http-signature-zcap-invoke` 6.3.0 and two delegated zcaps (a one- and a two-link chain) from
 *    `@interop/ezcap` 7.5.4 with the `eddsa-jcs-2022` suite from `@interop/ed25519-signature` 7.2.5, using the three
 *    deterministic identities below (seed bytes 0x01, 0x02, 0x03 repeated 32 times; test keys, never authorize them
 *    anywhere real), a frozen clock of 2026-11-05T12:00:00Z and a counter in place of `crypto.randomUUID()`.
 *    It was generated on 2026-11-05, with the operator's go-ahead, from a scratch install outside the repository
 *    (Node 24; the reference libraries are MIT or BSD-3-Clause licensed). The generator is kept OUT of the repository
 *    on purpose: it imports packages this repository does not depend on. `referenceVectors.spec.ts` checks every
 *    vector byte for byte. It also runs the same checks over a set built from this repository's own code, so the
 *    harness itself is proven, and keeps a `todo` for a checkout where the generated block has been emptied.
 *
 *    To regenerate it: run the generator (`generate.mjs`, then `emit-ts.mjs`, in a directory with the reference
 *    packages installed) and replace the block between the generated markers below. The generator's recipe is in
 *    the spec's "How the reference vectors are made" block.
 */

export interface PwsAuthzWorkedExample {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The `keyId` and the parameters exactly as printed in the Authorization header. */
  authorization: {
    keyId: string;
    headers: string;
    signature: string;
    created: string;
    expires: string;
  };
}

export const PWS_AUTHZ_WORKED_EXAMPLE: PwsAuthzWorkedExample = {
  method: 'PUT',
  url: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/photos/sunset.png',
  headers: {
    host: 'example.com',
    'content-type': 'image/png',
    digest: 'mh=uEiCPO-qYr-z0GYV5F75-N1l8Rhjv4xIkKZsnbTZeZ7emSA',
    'capability-invocation':
      'zcap id="urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2Fphotos%2Fsunset.png",action="PUT"',
  },
  authorization: {
    keyId:
      'did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJNdVW#z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJNdVW',
    headers: '(key-id) (created) (expires) (request-target) host capability-invocation content-type digest',
    signature: '6GoRQ+rW69wBhNyERkafAXEZXZArezHvGRNUWC0HNI4Ss1xAiiMHdayS5aA2R6hLuYRNw6h9J9eCmQVMuHE1Bw==',
    created: '1758150502',
    expires: '1758151102',
  },
};

export interface ReferenceIdentity {
  seedHex: string;
  did: string;
  keyId: string;
  publicKeyMultibase: string;
}

export interface ReferenceInvocationVector {
  label: string;
  invoker: 'alice' | 'appDid' | 'bob';
  method: string;
  url: string;
  created: number;
  expires: number;
  /** The body as bytes-in-a-string, or null for a bodyless request. */
  body: string | null;
  capabilityKind: 'root' | 'delegated';
  /** Every header the reference produced, lowercase names. */
  headers: Record<string, string>;
  coveredHeaders: string[];
  signingString: string;
}

export interface ReferenceStackVectors {
  generatedAt: string;
  packages: Record<string, string>;
  identities: { alice: ReferenceIdentity; appDid: ReferenceIdentity; bob: ReferenceIdentity };
  spaceId: string;
  spaceUrl: string;
  collectionUrl: string;
  resourceUrl: string;
  rootCapabilityIds: { space: string; collection: string; resource: string };
  clock: { nowSeconds: number };
  digestOfBody: { body: string; digest: string };
  /** L1: Space root -> appDid. L2: L1 -> bob. Both signed with eddsa-jcs-2022. */
  delegations: { L1: Record<string, unknown>; L2: Record<string, unknown> };
  invocations: ReferenceInvocationVector[];
}

// <generated:start>
export const REFERENCE_STACK_VECTORS: ReferenceStackVectors | null = {
  generatedAt: '2026-11-05',
  packages: {
    '@interop/ezcap': '7.5.4',
    '@interop/zcap': '11.4.0',
    '@interop/http-signature-zcap-invoke': '6.3.0',
    '@interop/http-digest-header': '3.2.0',
    '@interop/ed25519-signature': '7.2.5',
    '@interop/ed25519-verification-key': '8.2.2',
  },
  identities: {
    alice: {
      seedHex: '0101010101010101010101010101010101010101010101010101010101010101',
      did: 'did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX',
      keyId:
        'did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX#z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX',
      publicKeyMultibase: 'z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX',
    },
    appDid: {
      seedHex: '0202020202020202020202020202020202020202020202020202020202020202',
      did: 'did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH',
      keyId:
        'did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH#z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH',
      publicKeyMultibase: 'z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH',
    },
    bob: {
      seedHex: '0303030303030303030303030303030303030303030303030303030303030303',
      did: 'did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2',
      keyId:
        'did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2#z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2',
      publicKeyMultibase: 'z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2',
    },
  },
  spaceId: '81246131-69a4-45ab-9bff-9c946b59cf2e',
  spaceUrl: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/',
  collectionUrl: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/',
  resourceUrl: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/hello-world',
  rootCapabilityIds: {
    space: 'urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2F',
    collection:
      'urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2Fmessages%2F',
    resource:
      'urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2Fmessages%2Fhello-world',
  },
  clock: {
    nowSeconds: 1793880000,
  },
  digestOfBody: {
    body: '{"message":"hi"}',
    digest: 'mh=uEiCtvZgrj-C72Ed_CSYgKNOsJkAB3Dbjx1eZBecsC3GHVQ',
  },
  delegations: {
    L1: {
      '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
      id: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      controller: 'did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH',
      parentCapability:
        'urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2F',
      invocationTarget: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/',
      expires: '2027-01-01T00:00:00Z',
      allowedAction: ['GET', 'HEAD'],
      proof: {
        type: 'DataIntegrityProof',
        created: '2026-11-05T11:00:00Z',
        verificationMethod:
          'did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX#z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX',
        cryptosuite: 'eddsa-jcs-2022',
        proofPurpose: 'capabilityDelegation',
        capabilityChain: [
          'urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2F',
        ],
        '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
        proofValue:
          'z4jc8ZsnY27WRejYRne7XSJo2SAdPhRrYeQps36nqmsj6ZG1NfKfh61K7Uxt1GejVnX8Ek9wbN5R8fDGPkLiw97fP',
      },
    },
    L2: {
      '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
      id: 'urn:uuid:00000000-0000-4000-8000-000000000002',
      controller: 'did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2',
      parentCapability: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      invocationTarget: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/hello-world',
      expires: '2026-12-31T00:00:00Z',
      allowedAction: ['GET'],
      proof: {
        type: 'DataIntegrityProof',
        created: '2026-11-05T11:30:00Z',
        verificationMethod:
          'did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH#z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH',
        cryptosuite: 'eddsa-jcs-2022',
        proofPurpose: 'capabilityDelegation',
        capabilityChain: [
          'urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2F',
          {
            '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
            id: 'urn:uuid:00000000-0000-4000-8000-000000000001',
            controller: 'did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH',
            parentCapability:
              'urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2F',
            invocationTarget: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/',
            expires: '2027-01-01T00:00:00Z',
            allowedAction: ['GET', 'HEAD'],
            proof: {
              type: 'DataIntegrityProof',
              created: '2026-11-05T11:00:00Z',
              verificationMethod:
                'did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX#z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX',
              cryptosuite: 'eddsa-jcs-2022',
              proofPurpose: 'capabilityDelegation',
              capabilityChain: [
                'urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2F',
              ],
              '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
              proofValue:
                'z4jc8ZsnY27WRejYRne7XSJo2SAdPhRrYeQps36nqmsj6ZG1NfKfh61K7Uxt1GejVnX8Ek9wbN5R8fDGPkLiw97fP',
            },
          },
        ],
        '@context': ['https://w3id.org/zcap/v1', 'https://w3id.org/security/data-integrity/v2'],
        proofValue:
          'z5qiT9FyfEa8T3MMxKuH8P6JKx88xQHMw9hwRsqUEALfthcVKiXy9x4NinEruNE8EPL3FXtreGSjbQY5xwxmzYehZ',
      },
    },
  },
  invocations: [
    {
      label: 'GET resource, root capability of the resource URL',
      invoker: 'alice',
      method: 'GET',
      url: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/hello-world',
      created: 1793880000,
      expires: 1793880600,
      body: null,
      capabilityKind: 'root',
      headers: {
        host: 'example.com',
        'capability-invocation':
          'zcap id="urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2Fmessages%2Fhello-world",action="GET"',
        authorization:
          'Signature keyId="did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX#z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX",headers="(key-id) (created) (expires) (request-target) host capability-invocation",signature="nFjnUADYCkxRLbsUsz2PkYOwdKjYB/IJfnPlAy8Kx6rkiatSmpwQN6ldAUTXGLcoG4KV8qXqOQXlZI4iJOSzAA==",created="1793880000",expires="1793880600"',
      },
      coveredHeaders: [
        '(key-id)',
        '(created)',
        '(expires)',
        '(request-target)',
        'host',
        'capability-invocation',
      ],
      signingString:
        '(key-id): did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX#z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX\n(created): 1793880000\n(expires): 1793880600\n(request-target): get /space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/hello-world\nhost: example.com\ncapability-invocation: zcap id="urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2Fmessages%2Fhello-world",action="GET"',
    },
    {
      label: 'PUT JSON resource, root capability of the Space URL',
      invoker: 'alice',
      method: 'PUT',
      url: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/hello-world',
      created: 1793880001,
      expires: 1793880601,
      body: '{"message":"hi"}',
      capabilityKind: 'root',
      headers: {
        host: 'example.com',
        'capability-invocation':
          'zcap id="urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2F",action="PUT"',
        digest: 'mh=uEiCtvZgrj-C72Ed_CSYgKNOsJkAB3Dbjx1eZBecsC3GHVQ',
        'content-type': 'application/json',
        authorization:
          'Signature keyId="did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX#z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX",headers="(key-id) (created) (expires) (request-target) host capability-invocation content-type digest",signature="VsbXz6lU9WfvjfZEAOZF6aULsK4PEy+1JHjfjEIULlnqHGPtEla/6FJZXyGefodT1Bstb/7f4zvENq/1qv0gDg==",created="1793880001",expires="1793880601"',
      },
      coveredHeaders: [
        '(key-id)',
        '(created)',
        '(expires)',
        '(request-target)',
        'host',
        'capability-invocation',
        'content-type',
        'digest',
      ],
      signingString:
        '(key-id): did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX#z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX\n(created): 1793880001\n(expires): 1793880601\n(request-target): put /space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/hello-world\nhost: example.com\ncapability-invocation: zcap id="urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F81246131-69a4-45ab-9bff-9c946b59cf2e%2F",action="PUT"\ncontent-type: application/json\ndigest: mh=uEiCtvZgrj-C72Ed_CSYgKNOsJkAB3Dbjx1eZBecsC3GHVQ',
    },
    {
      label: 'GET collection page with a query string, delegated capability L1',
      invoker: 'appDid',
      method: 'GET',
      url: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/?limit=2',
      created: 1793880002,
      expires: 1793880602,
      body: null,
      capabilityKind: 'delegated',
      headers: {
        host: 'example.com',
        'capability-invocation':
          'zcap capability="H4sIAAAAAAAAA7VTTXPaMBD9L-7kFsf4A2P7VBIINAHG5atApwdZWhuBsYwkAyaT_17ZIbTTXtpDNDvyrFb79r1d-UX7jFkm4SS14Lu2ljIXgWEcbUruGE-MM0a5cTC1279DAnDBqSwNgiTSqcJIavdgaT9uNUq0QCt4FhQFJUHjsvR6c6rNe3cvq6pRMeEsTYGrZKLytlAGZ3e4Zf56miTD42Yy7aInFM7iriv3uLROh5l7n432NtjM28_vadlXODnikMkHlKOIporThUolJuCMyaAWc2O3b6xHZXBCuzyFO8x2yhM5wqC-nmk5rmmbuusjR3eaKNL9KI51H_uOGzV9HFvVNVWOZgeGkaQsmyKegOrktVu_QRs1sPEvsMYOhEAJCEOhwymnHIQCtRpWS2-YyqaNRlDbSl1AacqOQNq4YlBNsdedquN-t92pJpErxbEWvGiyzEGhdNS4vrxPK6yDqvMckATyVsTVTVWkOTXNX0UOwGlM31QOQa4Z-XNEmT0CTNzRdlvGrMf6J0qsc9bDTX8ws59buyJCY_wYDeLB4tP_JtQMy1wyUVBZiQBCBNI3WOiKr6VdVIYFz5mo4vg6-w6kkNS0K5Dr8cMa0bpZH_cwVO8_5t-qtc5RWlRKz84GeyuRLa3WtzFsluMMWovJE7MmbRKux3wJX3Nhu9l-JzbuqmeO4ud47ZrPrdlJmj3YzLOF1936x2jUHHtxpxduB_Tot-JQe339CYlDMVAdBAAA",action="GET"',
        authorization:
          'Signature keyId="did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH#z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH",headers="(key-id) (created) (expires) (request-target) host capability-invocation",signature="JiMWmd5uP3BeMdmWMaLXg0loyMEfJkdY++N+yefR9qB4Ry6Y9DC+ZmknXVxckaeA31yg0aGe+X1DqzZpcO5jCA==",created="1793880002",expires="1793880602"',
      },
      coveredHeaders: [
        '(key-id)',
        '(created)',
        '(expires)',
        '(request-target)',
        'host',
        'capability-invocation',
      ],
      signingString:
        '(key-id): did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH#z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH\n(created): 1793880002\n(expires): 1793880602\n(request-target): get /space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/?limit=2\nhost: example.com\ncapability-invocation: zcap capability="H4sIAAAAAAAAA7VTTXPaMBD9L-7kFsf4A2P7VBIINAHG5atApwdZWhuBsYwkAyaT_17ZIbTTXtpDNDvyrFb79r1d-UX7jFkm4SS14Lu2ljIXgWEcbUruGE-MM0a5cTC1279DAnDBqSwNgiTSqcJIavdgaT9uNUq0QCt4FhQFJUHjsvR6c6rNe3cvq6pRMeEsTYGrZKLytlAGZ3e4Zf56miTD42Yy7aInFM7iriv3uLROh5l7n432NtjM28_vadlXODnikMkHlKOIporThUolJuCMyaAWc2O3b6xHZXBCuzyFO8x2yhM5wqC-nmk5rmmbuusjR3eaKNL9KI51H_uOGzV9HFvVNVWOZgeGkaQsmyKegOrktVu_QRs1sPEvsMYOhEAJCEOhwymnHIQCtRpWS2-YyqaNRlDbSl1AacqOQNq4YlBNsdedquN-t92pJpErxbEWvGiyzEGhdNS4vrxPK6yDqvMckATyVsTVTVWkOTXNX0UOwGlM31QOQa4Z-XNEmT0CTNzRdlvGrMf6J0qsc9bDTX8ws59buyJCY_wYDeLB4tP_JtQMy1wyUVBZiQBCBNI3WOiKr6VdVIYFz5mo4vg6-w6kkNS0K5Dr8cMa0bpZH_cwVO8_5t-qtc5RWlRKz84GeyuRLa3WtzFsluMMWovJE7MmbRKux3wJX3Nhu9l-JzbuqmeO4ud47ZrPrdlJmj3YzLOF1936x2jUHHtxpxduB_Tot-JQe339CYlDMVAdBAAA",action="GET"',
    },
    {
      label: 'GET resource through the two-link chain L1 -> L2',
      invoker: 'bob',
      method: 'GET',
      url: 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/hello-world',
      created: 1793880003,
      expires: 1793880603,
      body: null,
      capabilityKind: 'delegated',
      headers: {
        host: 'example.com',
        'capability-invocation':
          'zcap capability="H4sIAAAAAAAAA9VTXW-bMBT9L0x7KyNAQoCnZQ1N1nyIJqRNMu3BmEtwQjAxJkCq_vcZ1lZTp02Npk6bZRld7Ht9zzk-99JHTBMOJZfsL1LEeZrZilLoJPhA2UY5YZQqR1W6-HkrA5wzwislQBzJRNTYNOFRk75eSCSQbClniZ3nJLBbj0Nulna9mE_h49DEHXUnjMYxMJEciLwdVPbJmOyOs-V0hZ3uZBLkVXLnbWDk95GnErLtzy_NdH1YrrHJhi4L6zopYpDwS5Qin8SipzNbqeGS5Egx4oQmHmIbEOw8MwAl2qcxfMB0r2QpwqCYqtY2VF2VDQu15XYH-bLlh6FsYatt-B0Lhxooe8gytIFMiSCOqVxQFgfiIihTwiAT9bWWZsiqJuuq12rZzVyLA0icLiDo4bqZWqSB49UMp4zSULLvJV6lINL7QobPTyq4zaZglAHiEDxXV-VWx1NVW3-qfgRGQvId6QR4RIMX1FMr8jabSbGdew66Ru4idAx-wJVWHhfGp2R60EGn5uH2E6mG785NaDqsUk6znPAaBARBhuQtzmTRbyNlDcTNWUqzeh8_a9qHGDZN23WR59-XESINS7Xg9eu1RQFuN9q913vvtSsxf1BQRI2G4vsaFcUx6eL-X_GM-jvPnKnDLzzzRhS-pb9emqort8Szf4WpLqSh0-v_sbdar_dWok8BB8Z0t6tCOqDDkgTaKRngjjVe6KPuPvfRDF_543C8fHduwn_pLcH923irwXqL4rxGempvsbnOkpXWvZvBdjVLoLucX1Nt3gvcaMZWcJNmupEc9tnWWA_UaTgKI0MddRclVwewvU2WprOzCn_amZlhf-DuxqSwuqErPTz8JQSdA_Gsqyp0kOnpk0k5yoema1yPStMsb4aTwoqKWXZYOL1xyCN8OyLLyirbU5I4LJ86puOO9aslZzCYb_2bVacsyv1pBdFaIPgG-_QZOhMIAAA",action="GET"',
        authorization:
          'Signature keyId="did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2#z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2",headers="(key-id) (created) (expires) (request-target) host capability-invocation",signature="igpiTHBybIMBMd+9hJWrtKKH1Sga6GP25ykgdlLzRKRFGtW8nWtwrcL6T57KkBFXUKfljOrqNCQVWst5RejRBg==",created="1793880003",expires="1793880603"',
      },
      coveredHeaders: [
        '(key-id)',
        '(created)',
        '(expires)',
        '(request-target)',
        'host',
        'capability-invocation',
      ],
      signingString:
        '(key-id): did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2#z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2\n(created): 1793880003\n(expires): 1793880603\n(request-target): get /space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/hello-world\nhost: example.com\ncapability-invocation: zcap capability="H4sIAAAAAAAAA9VTXW-bMBT9L0x7KyNAQoCnZQ1N1nyIJqRNMu3BmEtwQjAxJkCq_vcZ1lZTp02Npk6bZRld7Ht9zzk-99JHTBMOJZfsL1LEeZrZilLoJPhA2UY5YZQqR1W6-HkrA5wzwislQBzJRNTYNOFRk75eSCSQbClniZ3nJLBbj0Nulna9mE_h49DEHXUnjMYxMJEciLwdVPbJmOyOs-V0hZ3uZBLkVXLnbWDk95GnErLtzy_NdH1YrrHJhi4L6zopYpDwS5Qin8SipzNbqeGS5Egx4oQmHmIbEOw8MwAl2qcxfMB0r2QpwqCYqtY2VF2VDQu15XYH-bLlh6FsYatt-B0Lhxooe8gytIFMiSCOqVxQFgfiIihTwiAT9bWWZsiqJuuq12rZzVyLA0icLiDo4bqZWqSB49UMp4zSULLvJV6lINL7QobPTyq4zaZglAHiEDxXV-VWx1NVW3-qfgRGQvId6QR4RIMX1FMr8jabSbGdew66Ru4idAx-wJVWHhfGp2R60EGn5uH2E6mG785NaDqsUk6znPAaBARBhuQtzmTRbyNlDcTNWUqzeh8_a9qHGDZN23WR59-XESINS7Xg9eu1RQFuN9q913vvtSsxf1BQRI2G4vsaFcUx6eL-X_GM-jvPnKnDLzzzRhS-pb9emqort8Szf4WpLqSh0-v_sbdar_dWok8BB8Z0t6tCOqDDkgTaKRngjjVe6KPuPvfRDF_543C8fHduwn_pLcH923irwXqL4rxGempvsbnOkpXWvZvBdjVLoLucX1Nt3gvcaMZWcJNmupEc9tnWWA_UaTgKI0MddRclVwewvU2WprOzCn_amZlhf-DuxqSwuqErPTz8JQSdA_Gsqyp0kOnpk0k5yoema1yPStMsb4aTwoqKWXZYOL1xyCN8OyLLyirbU5I4LJ86puOO9aslZzCYb_2bVacsyv1pBdFaIPgG-_QZOhMIAAA",action="GET"',
    },
  ],
};
// <generated:end>
