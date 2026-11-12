import { generateKeyPairSync } from 'node:crypto';

import {
  attenuateCapabilityToken,
  mintRootCapabilityToken,
  sealCapabilityToken,
  verifyCapabilityToken,
  type CapabilityToken,
} from '../capabilityToken';

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

  it('enforces path-segment boundaries and blocks prefix-sibling and traversal escapes', () => {
    const token = mintRootCapabilityToken(rootPriv, {
      subject: 'agent:solid-reader',
      scopes: ['memory:read'],
      resourcePrefix: '/solid/storage/user1',
      expiresAt: futureExp,
    });

    expect(verifyCapabilityToken(token, rootPub, { resource: '/solid/storage/user1' }).valid).toBe(true);
    expect(verifyCapabilityToken(token, rootPub, { resource: '/solid/storage/user1/entities' }).valid).toBe(
      true,
    );

    // Sibling prefix "/solid/storage/user10" must NOT match "/solid/storage/user1"
    const sibling = verifyCapabilityToken(token, rootPub, { resource: '/solid/storage/user10/secret' });
    expect(sibling.valid).toBe(false);

    // Dot-segment traversal must be refused
    const traversal = verifyCapabilityToken(token, rootPub, { resource: '/solid/storage/user1/../user2' });
    expect(traversal.valid).toBe(false);

    // Attenuation to a sibling prefix throws fail-closed
    expect(() => attenuateCapabilityToken(token, { resourcePrefix: '/solid/storage/user10' })).toThrow(
      /widen resourcePrefix/i,
    );
  });

  it('supports multi-hop attenuation, monotonic expiry narrowing, and sealCapabilityToken', () => {
    const baseNow = Date.now();
    const exp3 = new Date(baseNow + 30 * 60 * 1000).toISOString();
    const exp1 = new Date(baseNow + 5 * 60 * 1000).toISOString();

    const hop1 = mintRootCapabilityToken(rootPriv, {
      subject: 'agent:chain',
      scopes: ['memory:read', 'memory:write'],
      resourcePrefix: '/solid',
      expiresAt: exp3,
    });

    const hop2 = attenuateCapabilityToken(hop1, {
      scopes: ['memory:read'],
      resourcePrefix: '/solid/storage',
    });

    const hop3 = attenuateCapabilityToken(hop2, {
      resourcePrefix: '/solid/storage/pod-a',
      expiresAt: exp1,
    });

    expect(() =>
      attenuateCapabilityToken(hop2, { expiresAt: new Date(baseNow + 60 * 60 * 1000).toISOString() }),
    ).toThrow(/extend expiresAt/i);

    const sealed = sealCapabilityToken(hop3);
    expect(sealed.holderPrivateKeyDerB64).toBeUndefined();
    expect(() => attenuateCapabilityToken(sealed, {})).toThrow(/sealed/i);

    expect(
      verifyCapabilityToken(sealed, rootPub, {
        scope: 'memory:read',
        resource: '/solid/storage/pod-a/item',
        nowMs: baseNow + 60_000,
      }),
    ).toMatchObject({ valid: true, depth: 3 });

    expect(
      verifyCapabilityToken(sealed, rootPub, {
        scope: 'memory:read',
        nowMs: baseNow + 6 * 60 * 1000,
      }),
    ).toEqual({ valid: false, reason: 'capability token expired' });
  });

  it('rejects tampered attenuation, key swap attacks, malformed blocks, and excessive depth', () => {
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
    expect(verifyCapabilityToken(tampered, rootPub).valid).toBe(false);

    // Wrong verification key fails on block 0
    const { publicKey: wrongPub, privateKey: attackerPriv } = generateKeyPairSync('ed25519');
    expect(verifyCapabilityToken(root, wrongPub)).toEqual({
      valid: false,
      reason: 'invalid signature on block 0',
    });

    // Swapping holderPrivateKeyDerB64 fails attenuation immediately
    const attackerDer = Buffer.from(attackerPriv.export({ type: 'pkcs8', format: 'der' })).toString(
      'base64url',
    );
    expect(() =>
      attenuateCapabilityToken({ ...root, holderPrivateKeyDerB64: attackerDer }, { scopes: ['memory:read'] }),
    ).toThrow(/does not match/i);

    // Malformed untrusted payloads return { valid: false } without throwing
    expect(verifyCapabilityToken(null as unknown as CapabilityToken, rootPub).valid).toBe(false);
    expect(verifyCapabilityToken({ version: 'ci-cap-v1', blocks: [{} as never] }, rootPub)).toEqual({
      valid: false,
      reason: 'malformed capability block 0',
    });

    // Chain depth is bounded on both attenuation and verification
    let current = root;
    for (let i = 1; i < 16; i += 1) {
      current = attenuateCapabilityToken(current, {});
    }

    expect(verifyCapabilityToken(current, rootPub)).toMatchObject({ valid: true, depth: 16 });
    expect(() => attenuateCapabilityToken(current, {})).toThrow(/maximum attenuation depth/i);
    expect(
      verifyCapabilityToken({ ...current, blocks: [...current.blocks, current.blocks[0]!] }, rootPub).valid,
    ).toBe(false);
  });

  it('rejects invalid timestamps on mint and attenuation, and refuses further attenuation once sealed', () => {
    expect(() =>
      mintRootCapabilityToken(rootPriv, {
        subject: 'agent:bad-time',
        scopes: ['memory:read'],
        expiresAt: 'not-a-timestamp',
      }),
    ).toThrow(RangeError);

    const root = mintRootCapabilityToken(rootPriv, {
      subject: 'agent:sealed',
      scopes: ['memory:read'],
      expiresAt: futureExp,
    });

    expect(() => attenuateCapabilityToken(root, { expiresAt: 'invalid-date' })).toThrow(RangeError);

    const sealed = attenuateCapabilityToken(root, { scopes: ['memory:read'] }, { seal: true });
    expect(sealed.holderPrivateKeyDerB64).toBeUndefined();
    expect(() => attenuateCapabilityToken(sealed, { scopes: ['memory:read'] })).toThrow(/sealed/i);
  });
});
