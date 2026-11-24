import { createHash } from 'node:crypto';

import { digestHeaderValue, verifyDigestHeader } from './digest';
import { multibaseEncode, sha256Multihash } from './multibase';

const ascii = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'ascii'));

/**
 * The wire form is that of `@interop/http-digest-header` 3.2.0 `createHeaderValue({ useMultihash: true })`, read
 * from its source: `mh=` + `u` + base64url(0x12 0x20 || sha256(data)). The SHA-256 values below are the published
 * ones for "abc" (FIPS 180-2 Appendix B.1) and for the empty string, so the expected strings are not produced by
 * the code under test.
 */
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const multihashHeader = (digestHex: string): string =>
  `mh=u${Buffer.from(`1220${digestHex}`, 'hex').toString('base64url')}`;

describe('digestHeaderValue', () => {
  it('is mh= and the unpadded base64url of the sha2-256 multihash', () => {
    expect(digestHeaderValue(ascii('abc'))).toBe(multihashHeader(SHA256_ABC));
    expect(digestHeaderValue(new Uint8Array(0))).toBe(multihashHeader(SHA256_EMPTY));
    expect(digestHeaderValue(ascii('abc'))).toBe(`mh=${multibaseEncode('u', sha256Multihash(ascii('abc')))}`);
  });

  it('has the shape of the PWS-AUTHZ worked example: 43 base64url characters after mh=uEi', () => {
    // The specification prints Digest: mh=uEiCPO-qYr-z0GYV5F75-N1l8Rhjv4xIkKZsnbTZeZ7emSA
    const value = digestHeaderValue(ascii('some photo bytes'));

    expect(value).toMatch(/^mh=uEi[A-D][A-Za-z0-9_-]{43}$/);
    expect('mh=uEiCPO-qYr-z0GYV5F75-N1l8Rhjv4xIkKZsnbTZeZ7emSA').toMatch(/^mh=uEi[A-D][A-Za-z0-9_-]{43}$/);
    expect(
      Buffer.from('uEiCPO-qYr-z0GYV5F75-N1l8Rhjv4xIkKZsnbTZeZ7emSA'.slice(1), 'base64url')
        .subarray(0, 2)
        .toString('hex'),
    ).toBe('1220');
  });

  it('matches an independent computation for arbitrary bytes', () => {
    const body = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
    const digest = createHash('sha256').update(body).digest('hex');

    expect(digestHeaderValue(body)).toBe(multihashHeader(digest));
  });
});

describe('verifyDigestHeader', () => {
  const body = ascii('{"message":"hi"}');
  const good = digestHeaderValue(body);

  it('accepts the digest of exactly this body', () => {
    expect(verifyDigestHeader(good, body)).toBe(true);
    expect(verifyDigestHeader(multihashHeader(SHA256_EMPTY), new Uint8Array(0))).toBe(true);
  });

  it('rejects a different body, including one differing in a single byte', () => {
    expect(verifyDigestHeader(good, ascii('{"message":"ho"}'))).toBe(false);
    expect(verifyDigestHeader(good, new Uint8Array(0))).toBe(false);
  });

  it('rejects every other spelling of a digest and every malformation, without throwing', () => {
    const base64Sha256 = `SHA-256=${createHash('sha256').update(body).digest('base64')}`;
    const sha512Multihash = `mh=u${Buffer.from([0x13, 0x40, ...createHash('sha512').update(body).digest()]).toString('base64url')}`;

    for (const bad of [
      '',
      'mh=',
      'mh=u',
      'mh=uEiC',
      good.slice(0, -1),
      `${good}A`,
      good.replace('mh=u', 'mh=z'),
      good.replace('mh=u', 'MH=u'),
      ` ${good}`,
      `${good} `,
      `${good},${base64Sha256}`,
      base64Sha256,
      sha512Multihash,
      'mh=u+/+/',
      'mh=uEiC!!!!',
    ]) {
      expect(verifyDigestHeader(bad, body)).toBe(false);
    }
  });
});
