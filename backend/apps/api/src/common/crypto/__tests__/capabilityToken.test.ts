import { generateKeyPairSync } from 'node:crypto';

import { attenuateCapabilityToken, mintRootCapabilityToken, verifyCapabilityToken } from '../capabilityToken';

describe('capabilityToken (Biscuit-style offline attenuation)', () => {
  const { publicKey: rootPub, privateKey: rootPriv } = generateKeyPairSync('ed25519');
  const futureExp = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it('mints, attenuates offline, and verifies monotonic narrowing', () => {
    const root = mintRootCapabilityToken(rootPriv, {
      subject: 'agent:openclaw',
      scopes: ['memory:read', 'memory:write', 'asks:send'],
      resourcePrefix: '/memory/',
      expiresAt: futureExp,
    });

    const narrowed = attenuateCapabilityToken(root, {
      scopes: ['memory:read'],
      resourcePrefix: '/memory/context',
      note: 'delegated read-only sub-agent',
    });

    const res = verifyCapabilityToken(narrowed, rootPub, {
      scope: 'memory:read',
      resource: '/memory/context/123',
    });
    expect(res).toMatchObject({
      valid: true,
      subject: 'agent:openclaw',
      scopes: ['memory:read'],
      resourcePrefix: '/memory/context',
      depth: 2,
    });

    // Widened scope check fails
    const forbidden = verifyCapabilityToken(narrowed, rootPub, { scope: 'memory:write' });
    expect(forbidden).toEqual({ valid: false, reason: 'missing required scope: memory:write' });

    // Outside resource prefix fails
    const outside = verifyCapabilityToken(narrowed, rootPub, { resource: '/memory/write' });
    expect(outside.valid).toBe(false);
  });

  it('rejects tampered attenuation that attempts to widen scopes or extend expiry', () => {
    const root = mintRootCapabilityToken(rootPriv, {
      subject: 'agent:hermes',
      scopes: ['memory:read'],
      resourcePrefix: '/memory/context',
      expiresAt: futureExp,
    });

    const tampered = {
      ...root,
      blocks: [
        ...root.blocks,
        {
          ...root.blocks[0]!,
          scopes: ['memory:read', 'memory:write'],
        },
      ],
    };

    const res = verifyCapabilityToken(tampered, rootPub);
    expect(res.valid).toBe(false);
  });

  it('refuses further attenuation once sealed', () => {
    const root = mintRootCapabilityToken(rootPriv, {
      subject: 'agent:sealed',
      scopes: ['memory:read'],
      expiresAt: futureExp,
    });

    const sealed = attenuateCapabilityToken(root, { scopes: ['memory:read'] }, { seal: true });
    expect(sealed.holderPrivateKeyDerB64).toBeUndefined();
    expect(() => attenuateCapabilityToken(sealed, { scopes: ['memory:read'] })).toThrow(/sealed/i);
  });
});
