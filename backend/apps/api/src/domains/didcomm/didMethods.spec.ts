import { relationshipKeys, didcommEndpoints } from './didDocument';
import { didKeyFromJwk, jwkFromDidKey, resolveDidKey } from './didKey';
import { createDidPeer2, resolveDidPeer } from './didPeer';
import { createDidWebResolver, didWebToUrl } from './didWeb';
import { DidcommError } from './errors';
import { generateKeyPair, type KeyCurve } from './jwk';
import { multikeyFromJwk } from './multikey';

describe('did:key', () => {
  const ED = 'did:key:z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V';

  it('reads the key out of the identifier', () => {
    expect(jwkFromDidKey(ED)).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'owBhCbktDjkfS6PdQddT0D3yjSitaSysP3YimJ_YgmA',
    });
    expect(didKeyFromJwk(jwkFromDidKey(ED))).toBe(ED);
  });

  it('resolves an Ed25519 did:key into a signing key and a derived X25519 key agreement key', () => {
    const doc = resolveDidKey(ED);
    const [signing] = relationshipKeys(doc, 'authentication');
    const [agreement] = relationshipKeys(doc, 'keyAgreement');

    expect(doc.id).toBe(ED);
    expect(signing.id).toBe(`${ED}#z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V`);
    expect(signing.jwk.crv).toBe('Ed25519');
    expect(agreement.jwk.crv).toBe('X25519');
    expect(agreement.id.startsWith(`${ED}#z6LS`)).toBe(true);
    expect(relationshipKeys(doc, 'assertionMethod')).toHaveLength(1);
    expect(relationshipKeys(doc, 'capabilityInvocation')).toHaveLength(1);
    expect(relationshipKeys(doc, 'capabilityDelegation')).toHaveLength(1);
  });

  it('resolves an X25519 did:key into a key agreement key only', () => {
    const did = didKeyFromJwk(generateKeyPair('X25519').publicJwk);
    const doc = resolveDidKey(did);

    expect(relationshipKeys(doc, 'keyAgreement')).toHaveLength(1);
    expect(relationshipKeys(doc, 'authentication')).toEqual([]);
  });

  it.each(['P-256', 'P-384', 'P-521', 'secp256k1'] as KeyCurve[])(
    'resolves a %s did:key with the key in every relationship',
    (curve) => {
      const { publicJwk } = generateKeyPair(curve);
      const doc = resolveDidKey(didKeyFromJwk(publicJwk));

      expect(relationshipKeys(doc, 'authentication')[0].jwk).toMatchObject({
        crv: curve,
        x: publicJwk.x,
        y: publicJwk.y,
      });
      expect(relationshipKeys(doc, 'keyAgreement')[0].jwk.crv).toBe(curve);
    },
  );

  it.each([
    'did:key:',
    'did:key:6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V',
    `${ED}#z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V`,
    `${ED}/path`,
    `${ED}?x=1`,
    'did:web:example.com',
    'did:key:z6LS',
    'did:key:zQmNotAKey',
  ])('refuses %s', (did) => {
    expect(() => resolveDidKey(did)).toThrow(DidcommError);
  });
});

describe('did:peer:2', () => {
  const E = 'z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc';
  const V = 'z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V';
  /** The specification's numalgo-2 example: DIDComm service with a routing key and two accept profiles. */
  const SPEC_EXAMPLE =
    `did:peer:2.E${E}.V${V}.` +
    'SeyJ0IjoiZG0iLCJzIjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9lbmRwb2ludCIsInIiOlsiZGlkOmV4YW1wbGU6c29tZW1lZGlhdG9yI3NvbWVrZXkiXSwiYSI6WyJkaWRjb21tL3YyIiwiZGlkY29tbS9haXAyO2Vudj1yZmM1ODciXX0';

  it('resolves the specification example', () => {
    const doc = resolveDidPeer(SPEC_EXAMPLE);

    expect(doc.id).toBe(SPEC_EXAMPLE);
    expect(relationshipKeys(doc, 'keyAgreement').map((key) => key.id)).toEqual([`${SPEC_EXAMPLE}#key-1`]);
    expect(relationshipKeys(doc, 'authentication').map((key) => key.id)).toEqual([`${SPEC_EXAMPLE}#key-2`]);
    expect(relationshipKeys(doc, 'keyAgreement')[0].jwk).toMatchObject({
      crv: 'X25519',
      x: 'BIiFcQEn3dfvB2pjlhOQQour6jXy9d5s2FKEJNTOJik',
    });
    expect(relationshipKeys(doc, 'authentication')[0].jwk).toMatchObject({
      crv: 'Ed25519',
      x: 'owBhCbktDjkfS6PdQddT0D3yjSitaSysP3YimJ_YgmA',
    });
    expect(didcommEndpoints(doc)).toEqual([
      {
        id: `${SPEC_EXAMPLE}#service`,
        uri: 'https://example.com/endpoint',
        accept: ['didcomm/v2', 'didcomm/aip2;env=rfc587'],
        routingKeys: ['did:example:somemediator#somekey'],
      },
    ]);
  });

  it('creates that same identifier from the same keys and service', () => {
    const did = createDidPeer2({
      keys: [
        {
          purpose: 'keyAgreement',
          jwk: { kty: 'OKP', crv: 'X25519', x: 'BIiFcQEn3dfvB2pjlhOQQour6jXy9d5s2FKEJNTOJik' },
        },
        {
          purpose: 'authentication',
          jwk: { kty: 'OKP', crv: 'Ed25519', x: 'owBhCbktDjkfS6PdQddT0D3yjSitaSysP3YimJ_YgmA' },
        },
      ],
      services: [
        {
          uri: 'https://example.com/endpoint',
          routingKeys: ['did:example:somemediator#somekey'],
          accept: ['didcomm/v2', 'didcomm/aip2;env=rfc587'],
        },
      ],
    });

    expect(did).toBe(SPEC_EXAMPLE);
  });

  it('numbers keys across purposes in order and services from #service', () => {
    const k1 = generateKeyPair('X25519').publicJwk;
    const k2 = generateKeyPair('Ed25519').publicJwk;
    const k3 = generateKeyPair('P-256').publicJwk;
    const did = createDidPeer2({
      keys: [
        { purpose: 'authentication', jwk: k2 },
        { purpose: 'keyAgreement', jwk: k1 },
        { purpose: 'keyAgreement', jwk: k3 },
        { purpose: 'assertionMethod', jwk: k2 },
      ],
      services: [{ uri: 'https://a.example/in' }, { uri: 'wss://b.example/ws' }],
    });
    const doc = resolveDidPeer(did);

    expect(relationshipKeys(doc, 'authentication').map((key) => key.id)).toEqual([`${did}#key-1`]);
    expect(relationshipKeys(doc, 'keyAgreement').map((key) => key.id)).toEqual([
      `${did}#key-2`,
      `${did}#key-3`,
    ]);
    expect(relationshipKeys(doc, 'assertionMethod').map((key) => key.id)).toEqual([`${did}#key-4`]);
    expect(didcommEndpoints(doc).map((endpoint) => [endpoint.id, endpoint.uri])).toEqual([
      [`${did}#service`, 'https://a.example/in'],
      [`${did}#service-1`, 'wss://b.example/ws'],
    ]);
  });

  it('refuses numalgos other than 2', () => {
    for (const did of [
      'did:peer:0z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V',
      'did:peer:4zQm',
      'did:peer:1zQm',
      'did:peer:3zQm',
    ]) {
      expect(() => resolveDidPeer(did)).toThrow(/numalgo/);
    }

    expect(() => resolveDidPeer('did:key:z6Mk')).toThrow(DidcommError);
  });

  it.each([
    ['no elements', 'did:peer:2.'],
    ['an empty element', `did:peer:2.E${E}..V${V}`],
    ['an unknown purpose', `did:peer:2.X${E}`],
    ['no key at all', 'did:peer:2.SeyJ0IjoiZG0iLCJzIjoiaHR0cHM6Ly9hLmV4YW1wbGUifQ'],
    ['an Ed25519 key as key agreement', `did:peer:2.E${V}`],
    ['an X25519 key as authentication', `did:peer:2.V${E}`],
    ['a key without multibase', `did:peer:2.E${E.slice(1)}`],
    ['a service that is not base64url', `did:peer:2.E${E}.S!!!`],
    ['a service that is not JSON', `did:peer:2.E${E}.S${Buffer.from('nope').toString('base64url')}`],
    [
      'a service without a type',
      `did:peer:2.E${E}.S${Buffer.from('{"s":"https://a.example"}').toString('base64url')}`,
    ],
    [
      'a DIDComm service without a URI',
      `did:peer:2.E${E}.S${Buffer.from('{"t":"dm"}').toString('base64url')}`,
    ],
  ])('refuses %s', (_name, did) => {
    expect(() => resolveDidPeer(did)).toThrow(DidcommError);
  });

  it('refuses to create an identifier without keys or with a key in the wrong role', () => {
    expect(() => createDidPeer2({ keys: [] })).toThrow(DidcommError);
    expect(() =>
      createDidPeer2({ keys: [{ purpose: 'keyAgreement', jwk: generateKeyPair('Ed25519').publicJwk }] }),
    ).toThrow(DidcommError);
    expect(() =>
      createDidPeer2({ keys: [{ purpose: 'authentication', jwk: generateKeyPair('X25519').publicJwk }] }),
    ).toThrow(DidcommError);
  });

  it('keeps unknown service types as plain services', () => {
    const did = `did:peer:2.E${E}.S${Buffer.from('{"t":"other","s":"https://a.example"}').toString('base64url')}`;
    const doc = resolveDidPeer(did);

    expect(doc.service).toEqual([
      { id: `${did}#service`, type: 'other', serviceEndpoint: 'https://a.example' },
    ]);
    expect(didcommEndpoints(doc)).toEqual([]);
  });

  it('spells keys the way multikeyFromJwk does', () => {
    const { publicJwk } = generateKeyPair('X25519');

    expect(createDidPeer2({ keys: [{ purpose: 'keyAgreement', jwk: publicJwk }] })).toBe(
      `did:peer:2.E${multikeyFromJwk(publicJwk)}`,
    );
  });
});

describe('did:web', () => {
  it.each([
    ['did:web:example.com', 'https://example.com/.well-known/did.json'],
    ['did:web:example.com:users:alice', 'https://example.com/users/alice/did.json'],
    ['did:web:example.com%3A8443', 'https://example.com:8443/.well-known/did.json'],
    ['did:web:example.com%3A8443:a:b', 'https://example.com:8443/a/b/did.json'],
    ['did:web:Example.COM', 'https://example.com/.well-known/did.json'],
    ['did:web:sub.domain.example.org:x', 'https://sub.domain.example.org/x/did.json'],
  ])('maps %s to %s', (did, url) => {
    expect(didWebToUrl(did)).toBe(url);
  });

  it.each([
    ['localhost', 'did:web:localhost'],
    ['a numeric IPv4 address', 'did:web:127.0.0.1'],
    ['an IPv4 address with a port', 'did:web:10.0.0.1%3A8080'],
    ['an IPv6 literal', 'did:web:%5B%3A%3A1%5D'],
    ['credentials in the host', 'did:web:user%40example.com'],
    ['an underscore in a host label', 'did:web:exa_mple.com'],
    ['a port out of range', 'did:web:example.com%3A70000'],
    ['a non-numeric port', 'did:web:example.com%3Aabc'],
    ['two ports', 'did:web:example.com%3A1%3A2'],
    ['a path-traversal segment', 'did:web:example.com:..:etc'],
    ['a dot segment', 'did:web:example.com:.'],
    ['an encoded slash in a segment', 'did:web:example.com:a%2Fb'],
    ['an empty segment', 'did:web:example.com::x'],
    ['a query', 'did:web:example.com?x=1'],
    ['a fragment', 'did:web:example.com#key-1'],
    ['bad percent-encoding', 'did:web:example.com%ZZ'],
    ['another method', 'did:key:z6Mk'],
    ['an over-long label', `did:web:${'a'.repeat(64)}.com`],
  ])('refuses %s', (_name, did) => {
    expect(() => didWebToUrl(did)).toThrow(DidcommError);
  });

  it('fetches through the injected function and checks the document is for that DID', async () => {
    const seen: string[] = [];
    const resolver = createDidWebResolver({
      fetchJson: async (url) => {
        seen.push(url);

        return { id: 'did:web:example.com', verificationMethod: [] };
      },
    });

    await expect(resolver.resolve('did:web:example.com')).resolves.toMatchObject({
      id: 'did:web:example.com',
    });
    expect(seen).toEqual(['https://example.com/.well-known/did.json']);
  });

  it('rejects a document that names a different DID, and turns fetch failures into resolution errors', async () => {
    const impostor = createDidWebResolver({ fetchJson: async () => ({ id: 'did:web:evil.example' }) });
    const down = createDidWebResolver({
      fetchJson: async () => {
        throw new Error('ECONNREFUSED 10.0.0.5:443');
      },
    });

    await expect(impostor.resolve('did:web:example.com')).rejects.toThrow(/different DID/);
    await expect(down.resolve('did:web:example.com')).rejects.toThrow(/could not fetch/);
    await expect(down.resolve('did:web:example.com')).rejects.not.toThrow(/10\.0\.0\.5/);
  });
});
