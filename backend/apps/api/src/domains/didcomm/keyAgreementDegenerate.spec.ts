import { diffieHellman } from 'node:crypto';

import { DidcommError } from './errors';
import { generateKeyPair, privateKeyObject, publicKeyObject } from './jwk';
import { ecdh } from './keyAgreement';

jest.mock('node:crypto', () => {
  const actual = jest.requireActual('node:crypto');

  return { ...actual, diffieHellman: jest.fn(actual.diffieHellman) };
});

/**
 * OpenSSL already refuses most small-order inputs, which is why this check is invisible in the
 * other specs. It exists for platforms and builds where `diffieHellman` returns the all-zero
 * secret instead of throwing, so it is tested by making `diffieHellman` do exactly that.
 */
describe('ecdh with a Diffie-Hellman that returns an all-zero secret', () => {
  const a = generateKeyPair('X25519');
  const b = generateKeyPair('X25519');

  it('refuses the degenerate secret instead of using it', () => {
    (diffieHellman as jest.Mock).mockReturnValueOnce(Buffer.alloc(32));

    expect(() => ecdh(privateKeyObject(a.privateJwk), publicKeyObject(b.publicJwk))).toThrow(DidcommError);

    (diffieHellman as jest.Mock).mockReturnValueOnce(Buffer.alloc(32));

    expect(() => ecdh(privateKeyObject(a.privateJwk), publicKeyObject(b.publicJwk))).toThrow(/degenerate/);
  });

  it('still returns an ordinary secret', () => {
    expect(ecdh(privateKeyObject(a.privateJwk), publicKeyObject(b.publicJwk))).toHaveLength(32);
  });
});
