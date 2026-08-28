import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import {
  BODY_COMPONENT,
  PEER_SIGNATURE_ALG,
  SignatureFormatError,
  buildSignatureBase,
  contentDigest,
  coversRequiredComponents,
  formatSignatureParams,
  jwkThumbprint,
  parseSignatureHeaders,
  publicKeyFromJwk,
  signSignatureBase,
  verifyContentDigest,
  verifySignatureBase,
  type SignatureParams,
} from './httpSignature';

function keypair(): { privateKey: KeyObject; publicKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  return { privateKey, publicKey, jwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown> };
}

const BODY = JSON.stringify({ askId: 'abc12345', prompt: 'do you know David Miller' });
const TARGET = 'https://peer.example/agent/v1/ask';

function params(overrides: Partial<SignatureParams> = {}): SignatureParams {
  return {
    components: ['@method', '@target-uri', BODY_COMPONENT],
    created: 1_800_000_000,
    expires: 1_800_000_060,
    keyid: 'a'.repeat(43),
    alg: PEER_SIGNATURE_ALG,
    nonce: 'n'.repeat(22),
    ...overrides,
  };
}

/** Produce the header pair a well-behaved peer would send. */
function sign(privateKey: KeyObject, overrides: Partial<SignatureParams> = {}, body = BODY) {
  const p = params(overrides);
  const rawParams = formatSignatureParams(p);
  const digest = contentDigest(body);
  const base = buildSignatureBase({
    components: p.components,
    method: 'POST',
    targetUri: TARGET,
    contentDigestHeader: digest,
    rawParams,
  });
  const signature = signSignatureBase(base, privateKey);

  return {
    signatureInput: `ci=${rawParams}`,
    signature: `ci=:${signature.toString('base64')}:`,
    digest,
    base,
  };
}

describe('contentDigest / verifyContentDigest', () => {
  it('round-trips a body', () => {
    expect(verifyContentDigest(contentDigest(BODY), BODY)).toBe(true);
  });

  it('is RFC 9530 shaped', () => {
    expect(contentDigest('hello')).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
  });

  it('fails when a single byte of the body changed', () => {
    expect(verifyContentDigest(contentDigest(BODY), `${BODY} `)).toBe(false);
  });

  it('fails on an absent header rather than passing', () => {
    expect(verifyContentDigest(undefined, BODY)).toBe(false);
    expect(verifyContentDigest('', BODY)).toBe(false);
  });

  it('refuses a digest that names a different algorithm', () => {
    // The sender does not get to pick the hash: a `sha-512=` header must fail
    // against a sha-256 expectation, not be accepted on its own terms.
    const sha512 = contentDigest(BODY).replace('sha-256', 'sha-512');
    expect(verifyContentDigest(sha512, BODY)).toBe(false);
  });
});

describe('parseSignatureHeaders', () => {
  const { privateKey } = keypair();

  it('parses a well-formed pair', () => {
    const { signatureInput, signature } = sign(privateKey);
    const parsed = parseSignatureHeaders(signatureInput, signature);

    expect(parsed.label).toBe('ci');
    expect(parsed.params.components).toEqual(['@method', '@target-uri', 'content-digest']);
    expect(parsed.params.alg).toBe('ed25519');
    expect(parsed.params.created).toBe(1_800_000_000);
    expect(parsed.params.expires).toBe(1_800_000_060);
  });

  it('preserves the raw parameter string byte for byte', () => {
    const { signatureInput } = sign(privateKey);
    const parsed = parseSignatureHeaders(signatureInput, 'ci=:AAAA:');

    // Re-serializing instead of preserving would break every honest signature
    // whose parameter order differs from ours.
    expect(signatureInput).toBe(`ci=${parsed.rawParams}`);
  });

  it.each([
    ['missing both', undefined, undefined],
    ['missing Signature', 'ci=("@method");created=1;expires=2', undefined],
    ['unparseable input', 'not-a-signature-input', 'ci=:AAAA:'],
    [
      'unquoted components',
      'ci=(@method);created=1;expires=2;keyid="x";alg="ed25519";nonce="n"',
      'ci=:AAAA:',
    ],
  ])('rejects %s', (_name, input, sig) => {
    expect(() => parseSignatureHeaders(input, sig)).toThrow(SignatureFormatError);
  });

  it('rejects a Signature whose label does not match Signature-Input', () => {
    const { signatureInput, signature } = sign(privateKey);

    expect(() => parseSignatureHeaders(signatureInput, signature.replace(/^ci=/, 'other='))).toThrow(
      /label mismatch/,
    );
  });

  it('rejects an algorithm other than ed25519', () => {
    const p = params({ alg: 'rsa-pss-sha512' });

    expect(() => parseSignatureHeaders(`ci=${formatSignatureParams(p)}`, 'ci=:AAAA:')).toThrow(
      /unsupported alg/,
    );
  });

  it('requires a nonce — the validity window alone is not a replay defence', () => {
    const raw = formatSignatureParams(params()).replace(/;nonce="[^"]*"/, '');

    expect(() => parseSignatureHeaders(`ci=${raw}`, 'ci=:AAAA:')).toThrow(/nonce/);
  });

  it('rejects a window that ends before it starts', () => {
    const p = params({ created: 1_800_000_060, expires: 1_800_000_000 });

    expect(() => parseSignatureHeaders(`ci=${formatSignatureParams(p)}`, 'ci=:AAAA:')).toThrow(
      /expires must be after created/,
    );
  });

  it('rejects a duplicated covered component', () => {
    const raw =
      '("@method" "@method");created=1;expires=2;keyid="' +
      'a'.repeat(43) +
      '";alg="ed25519";nonce="' +
      'n'.repeat(22) +
      '"';

    expect(() => parseSignatureHeaders(`ci=${raw}`, 'ci=:AAAA:')).toThrow(/duplicate covered component/);
  });

  it('rejects an unrecognized parameter rather than skipping it', () => {
    const raw = `${formatSignatureParams(params())};tag="whatever"`;

    // Anchored parsing: a parameter we do not understand is a refusal. A
    // permissive parser here accepts signatures that cover less than they look
    // like they cover.
    expect(() => parseSignatureHeaders(`ci=${raw}`, 'ci=:AAAA:')).toThrow(SignatureFormatError);
  });

  it('rejects a duplicated parameter', () => {
    const raw = `${formatSignatureParams(params())};created=999`;

    expect(() => parseSignatureHeaders(`ci=${raw}`, 'ci=:AAAA:')).toThrow(SignatureFormatError);
  });
});

describe('buildSignatureBase', () => {
  it('emits one line per component and ends with @signature-params, no trailing newline', () => {
    const rawParams = formatSignatureParams(params());
    const base = buildSignatureBase({
      components: ['@method', '@target-uri', BODY_COMPONENT],
      method: 'post',
      targetUri: TARGET,
      contentDigestHeader: contentDigest(BODY),
      rawParams,
    });

    const lines = base.split('\n');
    expect(lines[0]).toBe('"@method": POST');
    expect(lines[1]).toBe(`"@target-uri": ${TARGET}`);
    expect(lines[2]).toBe(`"content-digest": ${contentDigest(BODY)}`);
    expect(lines[3]).toBe(`"@signature-params": ${rawParams}`);
    expect(base.endsWith('\n')).toBe(false);
  });

  it('refuses to build a base for an unknown covered component', () => {
    expect(() =>
      buildSignatureBase({
        components: ['@method', 'x-something'],
        method: 'POST',
        targetUri: TARGET,
        rawParams: 'x',
      }),
    ).toThrow(/unsupported covered component/);
  });

  it('refuses when content-digest is covered but the header is absent', () => {
    expect(() =>
      buildSignatureBase({
        components: [BODY_COMPONENT],
        method: 'POST',
        targetUri: TARGET,
        rawParams: 'x',
      }),
    ).toThrow(/content-digest is covered but absent/);
  });
});

describe('coversRequiredComponents', () => {
  it('requires method and target on every request', () => {
    expect(coversRequiredComponents(['@method'], false)).toBe(false);
    expect(coversRequiredComponents(['@target-uri'], false)).toBe(false);
    expect(coversRequiredComponents(['@method', '@target-uri'], false)).toBe(true);
  });

  it('additionally requires content-digest when the request HAS a body', () => {
    // Derived from the request, never from the signature — otherwise a sender
    // drops the body binding simply by declining to cover it.
    expect(coversRequiredComponents(['@method', '@target-uri'], true)).toBe(false);
    expect(coversRequiredComponents(['@method', '@target-uri', BODY_COMPONENT], true)).toBe(true);
  });
});

describe('end-to-end sign and verify', () => {
  it('verifies a signature the same key produced', () => {
    const { privateKey, publicKey } = keypair();
    const { base, signature } = sign(privateKey);
    const parsed = parseSignatureHeaders(`ci=${formatSignatureParams(params())}`, signature);

    expect(verifySignatureBase(base, parsed.signature, publicKey)).toBe(true);
  });

  it('refuses a signature from a DIFFERENT key', () => {
    const alice = keypair();
    const mallory = keypair();
    const { base, signature } = sign(mallory.privateKey);
    const parsed = parseSignatureHeaders(`ci=${formatSignatureParams(params())}`, signature);

    expect(verifySignatureBase(base, parsed.signature, alice.publicKey)).toBe(false);
  });

  it('refuses when the BODY was rewritten in flight', () => {
    const { privateKey, publicKey } = keypair();
    const { signature } = sign(privateKey);
    const parsed = parseSignatureHeaders(`ci=${formatSignatureParams(params())}`, signature);

    // A proxy swaps the question. The digest line changes, so the base changes.
    const tampered = buildSignatureBase({
      components: params().components,
      method: 'POST',
      targetUri: TARGET,
      contentDigestHeader: contentDigest(JSON.stringify({ askId: 'abc12345', prompt: 'something else' })),
      rawParams: formatSignatureParams(params()),
    });

    expect(verifySignatureBase(tampered, parsed.signature, publicKey)).toBe(false);
  });

  it('refuses when the same signature is replayed onto a different ROUTE', () => {
    const { privateKey, publicKey } = keypair();
    const { signature } = sign(privateKey);
    const parsed = parseSignatureHeaders(`ci=${formatSignatureParams(params())}`, signature);

    // The collect route is a different authorization from the ask route, and
    // `@method`/`@target-uri` are what keep them from sharing one signature.
    const otherRoute = buildSignatureBase({
      components: params().components,
      method: 'GET',
      targetUri: 'https://peer.example/agent/v1/ask/abc12345',
      contentDigestHeader: contentDigest(BODY),
      rawParams: formatSignatureParams(params()),
    });

    expect(verifySignatureBase(otherRoute, parsed.signature, publicKey)).toBe(false);
  });

  it('returns false rather than throwing on a garbage signature', () => {
    const { publicKey } = keypair();

    expect(verifySignatureBase('base', Buffer.from('not a signature'), publicKey)).toBe(false);
  });
});

describe('jwkThumbprint', () => {
  it('is stable and base64url', () => {
    const { jwk } = keypair();
    const first = jwkThumbprint(jwk);

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jwkThumbprint({ ...jwk })).toBe(first);
  });

  it('ignores member order — the canonical form is what is hashed', () => {
    const { jwk } = keypair();
    const reordered = { x: jwk.x, kty: jwk.kty, crv: jwk.crv, use: 'sig', kid: 'ignored' };

    expect(jwkThumbprint(reordered)).toBe(jwkThumbprint(jwk));
  });

  it('distinguishes two keys', () => {
    expect(jwkThumbprint(keypair().jwk)).not.toBe(jwkThumbprint(keypair().jwk));
  });

  it('refuses anything that is not an Ed25519 public JWK', () => {
    expect(() => jwkThumbprint({ kty: 'RSA', n: 'x', e: 'AQAB' })).toThrow(SignatureFormatError);
    expect(() => jwkThumbprint({ kty: 'OKP', crv: 'X25519', x: 'abc' })).toThrow(SignatureFormatError);
    expect(() => jwkThumbprint({ kty: 'OKP', crv: 'Ed25519' })).toThrow(SignatureFormatError);
  });
});

describe('publicKeyFromJwk', () => {
  it('builds a usable verifying key', () => {
    const { privateKey, jwk } = keypair();
    const key = publicKeyFromJwk(jwk);
    const base = 'anything';

    expect(key).not.toBeNull();
    expect(verifySignatureBase(base, signSignatureBase(base, privateKey), key as KeyObject)).toBe(true);
  });

  it('REFUSES a JWK carrying a private component', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateJwk = privateKey.export({ format: 'jwk' });

    // A peer link must never hold a private key, so one is rejected at the door
    // rather than quietly stripped down to its public half.
    expect(privateJwk).toHaveProperty('d');
    expect(publicKeyFromJwk(privateJwk)).toBeNull();
  });

  it('returns null for junk rather than throwing', () => {
    expect(publicKeyFromJwk(null)).toBeNull();
    expect(publicKeyFromJwk({ kty: 'RSA' })).toBeNull();
    expect(publicKeyFromJwk('nope')).toBeNull();
  });
});
