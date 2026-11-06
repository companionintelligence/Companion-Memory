import {
  type DidDocument,
  didcommEndpoints,
  keyForKid,
  parseDidDocument,
  relationshipKeys,
} from './didDocument';
import { DidcommError } from './errors';
import { generateKeyPair } from './jwk';
import { multikeyFromJwk } from './multikey';
import { ALICE_DID_DOC, BOB_DID_DOC } from './__tests__/vectors';

const DID = 'did:example:carol';

function method(id: string, jwk: object, type = 'JsonWebKey2020') {
  return { id, type, controller: DID, publicKeyJwk: jwk };
}

describe('parseDidDocument', () => {
  it('accepts the specification documents', () => {
    expect(parseDidDocument(ALICE_DID_DOC, 'did:example:alice').id).toBe('did:example:alice');
    expect(parseDidDocument(BOB_DID_DOC, 'did:example:bob').id).toBe('did:example:bob');
  });

  it('refuses a document for a different DID than the one requested', () => {
    expect(() => parseDidDocument(ALICE_DID_DOC, 'did:example:bob')).toThrow(/different DID/);
  });

  it.each([
    ['a non-object', 'x'],
    ['an array', []],
    ['a missing id', {}],
    ['an id that is not a DID', { id: 'nope' }],
    ['an id that is a DID URL', { id: 'did:example:a#k' }],
    ['a non-array verificationMethod', { id: DID, verificationMethod: {} }],
    ['a non-array keyAgreement', { id: DID, keyAgreement: 'x' }],
    ['too many services', { id: DID, service: Array.from({ length: 300 }, () => ({})) }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseDidDocument(value)).toThrow(DidcommError);
  });
});

describe('relationshipKeys', () => {
  it('reads Alice: three authentication keys and three keyAgreement keys', () => {
    const doc = parseDidDocument(ALICE_DID_DOC);

    expect(relationshipKeys(doc, 'authentication').map((key) => key.jwk.crv)).toEqual([
      'Ed25519',
      'P-256',
      'secp256k1',
    ]);
    expect(relationshipKeys(doc, 'keyAgreement').map((key) => key.jwk.crv)).toEqual([
      'X25519',
      'P-256',
      'P-521',
    ]);
    expect(relationshipKeys(doc, 'assertionMethod')).toEqual([]);
  });

  it('reads Bob: nine keyAgreement keys and no authentication', () => {
    const doc = parseDidDocument(BOB_DID_DOC);

    expect(relationshipKeys(doc, 'keyAgreement')).toHaveLength(9);
    expect(relationshipKeys(doc, 'authentication')).toEqual([]);
  });

  it('stamps each key with its absolute id', () => {
    const [first] = relationshipKeys(parseDidDocument(BOB_DID_DOC), 'keyAgreement');

    expect(first.id).toBe('did:example:bob#key-x25519-1');
    expect(first.did).toBe('did:example:bob');
    expect(first.jwk.kid).toBe(first.id);
  });

  it('resolves references, relative references and embedded methods', () => {
    const a = generateKeyPair('X25519').publicJwk;
    const b = generateKeyPair('X25519').publicJwk;
    const c = generateKeyPair('P-256').publicJwk;
    const doc: DidDocument = {
      id: DID,
      verificationMethod: [method(`${DID}#a`, a), method('#b', b)],
      keyAgreement: [`${DID}#a`, '#b', method(`${DID}#c`, c)],
    };

    expect(relationshipKeys(doc, 'keyAgreement').map((key) => key.id)).toEqual([
      `${DID}#a`,
      `${DID}#b`,
      `${DID}#c`,
    ]);
  });

  it('never follows a reference into another DID, and skips entries it cannot read', () => {
    const key = generateKeyPair('X25519').publicJwk;
    const doc: DidDocument = {
      id: DID,
      verificationMethod: [method(`${DID}#a`, key), method('did:example:mallory#a', key)],
      keyAgreement: ['did:example:mallory#a', `${DID}#missing`, 42 as unknown as string, `${DID}#a`],
    };

    expect(relationshipKeys(doc, 'keyAgreement').map((entry) => entry.id)).toEqual([`${DID}#a`]);
  });

  it('refuses a method whose own id belongs to another DID, even when embedded', () => {
    const key = generateKeyPair('X25519').publicJwk;
    const doc: DidDocument = { id: DID, keyAgreement: [method('did:example:mallory#a', key)] };

    expect(relationshipKeys(doc, 'keyAgreement')).toEqual([]);
  });

  it('refuses a key whose declared type disagrees with its material', () => {
    const ed = generateKeyPair('Ed25519').publicJwk;
    const doc: DidDocument = {
      id: DID,
      verificationMethod: [
        {
          id: `${DID}#1`,
          type: 'X25519KeyAgreementKey2020',
          controller: DID,
          publicKeyMultibase: multikeyFromJwk(ed),
        },
        {
          id: `${DID}#2`,
          type: 'Ed25519VerificationKey2020',
          controller: DID,
          publicKeyMultibase: multikeyFromJwk(ed),
        },
      ],
      keyAgreement: [`${DID}#1`],
      authentication: [`${DID}#2`],
    };

    expect(relationshipKeys(doc, 'keyAgreement')).toEqual([]);
    expect(relationshipKeys(doc, 'authentication')).toHaveLength(1);
  });

  it('skips unsupported types, ambiguous material and private key members', () => {
    const key = generateKeyPair('X25519');
    const doc: DidDocument = {
      id: DID,
      verificationMethod: [
        { id: `${DID}#1`, type: 'Bls12381G2Key2020', controller: DID, publicKeyBase58: 'abc' },
        {
          id: `${DID}#2`,
          type: 'JsonWebKey2020',
          controller: DID,
          publicKeyJwk: key.publicJwk,
          publicKeyMultibase: multikeyFromJwk(key.publicJwk),
        },
        { id: `${DID}#3`, type: 'JsonWebKey2020', controller: DID, publicKeyJwk: key.privateJwk },
        { id: `${DID}#4`, type: 'JsonWebKey2020', controller: DID },
      ],
      keyAgreement: [`${DID}#1`, `${DID}#2`, `${DID}#3`, `${DID}#4`],
    };

    expect(relationshipKeys(doc, 'keyAgreement')).toEqual([]);
  });

  it('reads legacy base58 material where the type names the curve', () => {
    const doc: DidDocument = {
      id: 'did:example:eve',
      verificationMethod: [
        {
          id: 'did:example:eve#ed',
          type: 'Ed25519VerificationKey2018',
          controller: 'did:example:eve',
          publicKeyBase58: 'ByHnpUCFb1vAfh9CFZ8ZkmUZguURW8nSw889hy6rD8L7',
        },
      ],
      authentication: ['did:example:eve#ed'],
    };

    expect(relationshipKeys(doc, 'authentication')[0].jwk).toMatchObject({
      crv: 'Ed25519',
      x: 'owBhCbktDjkfS6PdQddT0D3yjSitaSysP3YimJ_YgmA',
    });
  });

  it('drops duplicate ids', () => {
    const key = generateKeyPair('X25519').publicJwk;
    const doc: DidDocument = {
      id: DID,
      verificationMethod: [method(`${DID}#a`, key)],
      keyAgreement: [`${DID}#a`, `${DID}#a`],
    };

    expect(relationshipKeys(doc, 'keyAgreement')).toHaveLength(1);
  });

  it('keyForKid finds an exact id under a relationship and nowhere else', () => {
    const doc = parseDidDocument(ALICE_DID_DOC);

    expect(keyForKid(doc, 'did:example:alice#key-1', 'authentication').jwk.crv).toBe('Ed25519');
    expect(() => keyForKid(doc, 'did:example:alice#key-1', 'keyAgreement')).toThrow(/key-1/);
    expect(() => keyForKid(doc, 'did:example:alice#nope', 'authentication')).toThrow(DidcommError);
  });
});

describe('didcommEndpoints', () => {
  const base = { id: DID };

  it('reads the object and array forms, in document order', () => {
    const endpoints = didcommEndpoints({
      ...base,
      service: [
        {
          id: `${DID}#didcomm-1`,
          type: 'DIDCommMessaging',
          serviceEndpoint: {
            uri: 'https://example.com/path',
            accept: ['didcomm/v2', 'didcomm/aip2;env=rfc587'],
            routingKeys: ['did:example:somemediator#somekey'],
          },
        },
        {
          id: '#second',
          type: ['Other', 'DIDCommMessaging'],
          serviceEndpoint: [{ uri: 'wss://example.com/ws' }, { uri: 'did:example:mediator' }],
        },
      ],
    });

    expect(endpoints).toEqual([
      {
        id: `${DID}#didcomm-1`,
        uri: 'https://example.com/path',
        accept: ['didcomm/v2', 'didcomm/aip2;env=rfc587'],
        routingKeys: ['did:example:somemediator#somekey'],
      },
      { id: `${DID}#second`, uri: 'wss://example.com/ws', accept: [], routingKeys: [] },
      { id: `${DID}#second`, uri: 'did:example:mediator', accept: [], routingKeys: [] },
    ]);
  });

  it('skips other service types and malformed endpoints but keeps the good ones', () => {
    const endpoints = didcommEndpoints({
      ...base,
      service: [
        { id: '#a', type: 'LinkedDomains', serviceEndpoint: { uri: 'https://x.example' } },
        { id: '#b', type: 'DIDCommMessaging', serviceEndpoint: 'https://string-form.example' },
        { id: '#c', type: 'DIDCommMessaging', serviceEndpoint: { uri: '' } },
        {
          id: '#d',
          type: 'DIDCommMessaging',
          serviceEndpoint: { uri: 'https://x.example', accept: 'didcomm/v2' },
        },
        {
          id: '#e',
          type: 'DIDCommMessaging',
          serviceEndpoint: { uri: 'https://x.example', routingKeys: ['not a did url'] },
        },
        { id: '#f', type: 'DIDCommMessaging', serviceEndpoint: { uri: 'https://good.example' } },
        { type: 'DIDCommMessaging', serviceEndpoint: { uri: 'https://no-id.example' } },
      ] as DidDocument['service'],
    });

    expect(endpoints.map((endpoint) => endpoint.uri)).toEqual(['https://good.example']);
  });

  it('returns nothing for a document with no services', () => {
    expect(didcommEndpoints(base)).toEqual([]);
  });
});
