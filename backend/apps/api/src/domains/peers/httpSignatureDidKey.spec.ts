import { generateKeyPairSync } from 'node:crypto';

import { base58btcEncode, didKeyIdFor, didKeyPublicJwk } from './didKeyId';
import {
  BODY_COMPONENT,
  PEER_SIGNATURE_ALG,
  SignatureFormatError,
  buildSignatureBase,
  contentDigest,
  formatSignatureParams,
  parseSignatureHeaders,
  publicKeyFromJwk,
  signSignatureBase,
  verifySignatureBase,
  type SignatureParams,
} from './httpSignature';

/**
 * The RFC 9421 profile accepts one more `keyid` spelling: a canonical Ed25519 `did:key`. These
 * pin the parser's side of it; the side that decides whether the key is the PEER's is
 * `PeerSignatureService`, and the side that decides which link answers is `PeerAskController`.
 */

const BODY = JSON.stringify({ askId: 'abc12345', prompt: 'do you know David Miller' });
const TARGET = 'https://peer.example/agent/v1/ask';

function params(keyid: string): SignatureParams {
  return {
    components: ['@method', '@target-uri', BODY_COMPONENT],
    created: 1_800_000_000,
    expires: 1_800_000_060,
    keyid,
    alg: PEER_SIGNATURE_ALG,
    nonce: 'n'.repeat(22),
  };
}

describe('parseSignatureHeaders — a did:key keyid', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const did = didKeyIdFor(publicKey.export({ format: 'jwk' }) as Record<string, unknown>) as string;

  it('is accepted, survives the round trip byte for byte, and verifies against the key the did:key spells out', () => {
    const rawParams = formatSignatureParams(params(did));
    const base = buildSignatureBase({
      components: params(did).components,
      method: 'POST',
      targetUri: TARGET,
      contentDigestHeader: contentDigest(BODY),
      rawParams,
    });
    const signature = signSignatureBase(base, privateKey);

    const parsed = parseSignatureHeaders(`ci=${rawParams}`, `ci=:${signature.toString('base64')}:`);

    expect(parsed.params.keyid).toBe(did);
    expect(parsed.rawParams).toBe(rawParams);

    // The verifying key is built from the DID ALONE, not from the generated key pair: no lookup of any kind.
    const fromDid = publicKeyFromJwk(didKeyPublicJwk(parsed.params.keyid));
    expect(fromDid).not.toBeNull();
    expect(verifySignatureBase(base, parsed.signature, fromDid as never)).toBe(true);

    // And a different did:key does not verify the same signature.
    const other = didKeyIdFor(
      generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
    ) as string;
    const wrongKey = publicKeyFromJwk(didKeyPublicJwk(other));
    expect(verifySignatureBase(base, parsed.signature, wrongKey as never)).toBe(false);
  });

  it.each([
    ['a DID URL with the key as fragment', (d: string) => `${d}#${d.slice('did:key:'.length)}`],
    ['a query', (d: string) => `${d}?versionId=1`],
    ['uppercase method', (d: string) => d.replace('did:key:', 'DID:KEY:')],
    ['a truncated key', (d: string) => d.slice(0, -1)],
    ['an X25519 key', () => 'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc'],
    ['a secp256k1 key', () => 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'],
    [
      'a key nobody can hold (the identity point), well formed in every other way',
      () =>
        `did:key:z${base58btcEncode(Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.from('01'.padEnd(64, '0'), 'hex')]))}`,
    ],
    ['did:web', () => 'did:web:local.pub'],
    ['did:webvh', () => 'did:webvh:QmSyntheticSyntheticSyntheticSyntheticSynth:alice.example'],
    ['did:scid:vh', () => 'did:scid:vh:1:QmSyntheticSyntheticSyntheticSyntheticSynth'],
  ])('refuses %s as a keyid', (_name, make) => {
    const rawParams = formatSignatureParams(params(make(did)));

    expect(() => parseSignatureHeaders(`ci=${rawParams}`, 'ci=:AAAA:')).toThrow(SignatureFormatError);
    expect(() => parseSignatureHeaders(`ci=${rawParams}`, 'ci=:AAAA:')).toThrow(/bad keyid/);
  });
});
