import { gzipSync } from 'node:zlib';

import { alice, app, bob } from './__tests__/testKit';
import { DidRegistry } from './keys';
import {
  ROOT_PREFIX,
  ZCAP_CONTEXT,
  ZcapError,
  actionsAttenuate,
  authorizeInvocation,
  chainFor,
  checkDelegatedZcap,
  decodeEmbeddedCapability,
  delegateCapability,
  formatCapabilityInvocation,
  isValidTarget,
  parseCapabilityInvocation,
  parseTime,
  parseRootZcapId,
  rootZcapId,
  verifyDelegationChain,
} from './zcap';
import type { ChainContext, DelegatedZcap, RootZcap } from './zcap';

const SPACE = 'https://example.com/space/s/';
const NOW = new Date('2026-11-05T12:00:00Z');

const context = (overrides: Partial<ChainContext> = {}): ChainContext => ({
  rootCapability: (id) => {
    const target = parseRootZcapId(id);

    return target
      ? ({ '@context': ZCAP_CONTEXT, id, controller: alice.did, invocationTarget: target } satisfies RootZcap)
      : undefined;
  },
  keys: new DidRegistry(),
  now: NOW,
  skewSeconds: 300,
  maxChainLength: 10,
  ...overrides,
});

const grant = (from = alice, to = app, over: Record<string, unknown> = {}): Promise<DelegatedZcap> =>
  delegateCapability({
    parent: rootZcapId(SPACE),
    signer: from.signer,
    controller: to.did,
    invocationTarget: `${SPACE}c/`,
    allowedAction: ['GET'],
    expires: '2027-01-01T00:00:00Z',
    created: '2026-11-05T11:00:00Z',
    ...over,
  });

describe('root capability ids', () => {
  it('is urn:zcap:root: plus the percent-encoded target, and has one spelling', () => {
    const id = rootZcapId('https://example.com/space/s/c/r');
    expect(id).toBe('urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2Fs%2Fc%2Fr');
    expect(parseRootZcapId(id)).toBe('https://example.com/space/s/c/r');
    expect(ROOT_PREFIX).toBe('urn:zcap:root:');
  });

  it('refuses ids that are not exactly that', () => {
    for (const id of [
      'urn:zcap:root:https://example.com/space/s/', // not percent-encoded
      'urn:zcap:root:https%3a%2f%2fexample.com%2f', // lower-case escapes are another spelling
      'urn:zcap:root:ftp%3A%2F%2Fexample.com%2F',
      'urn:zcap:root:%E0%A4%A',
      'urn:zcap:root:not-a-url',
      'urn:uuid:1234',
    ]) {
      expect(parseRootZcapId(id)).toBeUndefined();
    }
  });
});

describe('isValidTarget (attenuation by URL prefix)', () => {
  it('covers the target itself and what is beneath it at a path boundary', () => {
    expect(isValidTarget(`${SPACE}c/r`, SPACE)).toBe(true);
    expect(isValidTarget(SPACE, SPACE)).toBe(true);
    expect(isValidTarget(`${SPACE}c/r?limit=2`, `${SPACE}c/r`)).toBe(true);
    expect(isValidTarget(`${SPACE}c/r/meta`, `${SPACE}c/r`)).toBe(true);
    expect(isValidTarget(`${SPACE}c/?limit=2&cursor=x`, `${SPACE}c/`)).toBe(true);
  });

  it('does not cover a sibling, a parent, or a name that merely starts the same', () => {
    expect(isValidTarget(`${SPACE}evil/x`, `${SPACE}ev`)).toBe(false);
    expect(isValidTarget(`${SPACE}c/r2`, `${SPACE}c/r`)).toBe(false);
    expect(isValidTarget(SPACE, `${SPACE}c/`)).toBe(false);
    expect(isValidTarget('https://example.com/space/s2/', SPACE)).toBe(false);
    expect(isValidTarget('https://example.com:8443/space/s/', SPACE)).toBe(false);
  });

  it('keeps a query base a query base', () => {
    expect(isValidTarget(`${SPACE}c/?a=1&b=2`, `${SPACE}c/?a=1`)).toBe(true);
    expect(isValidTarget(`${SPACE}c/?a=1b`, `${SPACE}c/?a=1`)).toBe(false);
    expect(isValidTarget(`${SPACE}c/?b=2`, `${SPACE}c/?a=1`)).toBe(false);
  });
});

describe('actionsAttenuate', () => {
  it('lets a child narrow its parent and never widen it', () => {
    expect(actionsAttenuate(['GET'], ['GET', 'PUT'])).toBe(true);
    expect(actionsAttenuate(['GET', 'PUT'], ['GET'])).toBe(false);
    expect(actionsAttenuate(undefined, ['GET'])).toBe(false);
    expect(actionsAttenuate(['DELETE'], undefined)).toBe(true);
    expect(actionsAttenuate(undefined, undefined)).toBe(true);
  });
});

describe('Capability-Invocation header', () => {
  it('formats and parses the root form (id only) and the delegated form (gzip + base64url)', async () => {
    const root = formatCapabilityInvocation({ rootId: rootZcapId(SPACE), action: 'GET' });
    expect(root).toBe(`zcap id="${rootZcapId(SPACE)}",action="GET"`);
    expect(parseCapabilityInvocation(root)).toEqual({ rootId: rootZcapId(SPACE), action: 'GET' });

    const zcap = await grant();
    const delegated = parseCapabilityInvocation(
      formatCapabilityInvocation({ capability: zcap, action: 'PUT' }),
    );
    expect(delegated.action).toBe('PUT');
    expect(delegated.capability).toEqual(zcap);
  });

  it('refuses anything else', () => {
    for (const value of [
      '',
      'zcap',
      'bearer id="x",action="GET"',
      'zcap id="x"',
      'zcap action="GET"',
      'zcap id="x",capability="y",action="GET"',
      'zcap id="x",id="y",action="GET"',
      'zcap id="x",action="GET",extra="1"',
      'zcap id=x,action=GET',
      'zcap capability="!!!",action="GET"',
    ]) {
      expect(() => parseCapabilityInvocation(value)).toThrow(ZcapError);
    }
  });

  it('bounds what a header may inflate to', () => {
    const bomb = gzipSync(Buffer.alloc(1024 * 1024, 0x20)).toString('base64url');
    expect(() => decodeEmbeddedCapability(bomb)).toThrow(ZcapError);
    expect(() => decodeEmbeddedCapability(gzipSync(Buffer.from('not json')).toString('base64url'))).toThrow(
      ZcapError,
    );
  });
});

describe('checkDelegatedZcap', () => {
  it('accepts what delegateCapability makes', async () => {
    expect(() => checkDelegatedZcap(grant())).toBeDefined();
    const zcap = await grant();
    expect(checkDelegatedZcap(zcap)).toBe(zcap);
  });

  it('rejects each missing or malformed part', async () => {
    const zcap = await grant();
    const without = (member: string) => {
      const { [member]: _removed, ...rest } = zcap as unknown as Record<string, unknown>;

      return rest;
    };

    const proof = zcap.proof as unknown as Record<string, unknown>;
    const cases: unknown[] = [
      null,
      [],
      'x',
      without('id'),
      without('parentCapability'),
      without('invocationTarget'),
      without('controller'),
      without('expires'),
      without('proof'),
      { ...zcap, '@context': ['https://example.com/other'] },
      { ...zcap, '@context': ZCAP_CONTEXT },
      { ...zcap, expires: 'tomorrow' },
      { ...zcap, expires: '2027-02-30T00:00:00Z' },
      { ...zcap, allowedAction: [] },
      { ...zcap, allowedAction: [1] },
      { ...zcap, id: 'no-scheme' },
      { ...zcap, proof: [zcap.proof] },
      { ...zcap, proof: { ...proof, proofPurpose: 'capabilityInvocation' } },
      { ...zcap, proof: { ...proof, cryptosuite: 'Ed25519Signature2020' } },
      { ...zcap, proof: { ...proof, capabilityChain: [] } },
      { ...zcap, proof: { ...proof, created: 'then' } },
    ];
    for (const bad of cases) {
      expect(() => checkDelegatedZcap(bad)).toThrow(ZcapError);
    }
  });
});

describe('parseTime', () => {
  it('reads RFC 3339 date-times as epoch milliseconds, with offsets and fractions', () => {
    expect(parseTime('2026-11-05T12:00:00Z')).toBe(Date.UTC(2026, 10, 5, 12));
    expect(parseTime('2026-11-05T12:00:00.250Z')).toBe(Date.UTC(2026, 10, 5, 12, 0, 0, 250));
    expect(parseTime('2026-11-05T14:00:00+02:00')).toBe(Date.UTC(2026, 10, 5, 12));
    expect(parseTime('2026-11-05T10:30:00-01:30')).toBe(Date.UTC(2026, 10, 5, 12));
    expect(parseTime('2028-02-29T00:00:00Z')).toBe(Date.UTC(2028, 1, 29));
  });

  it('refuses what Date.parse would quietly roll forward or accept loosely', () => {
    for (const bad of [
      '2027-02-30T00:00:00Z',
      '2027-02-29T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-11-05T24:00:00Z',
      '2026-11-05T12:60:00Z',
      '2026-11-05T12:00:60Z',
      '2026-11-05T12:00:00',
      '2026-11-05 12:00:00Z',
      '2026-11-05T12:00:00+24:00',
      '0099-01-01T00:00:00Z',
      'tomorrow',
      '',
      42,
      null,
    ]) {
      expect(parseTime(bad)).toBeUndefined();
    }
  });
});

describe('chainFor', () => {
  it('is the root id for a root parent, and the parent chain with the parent appended in full for a delegated one', async () => {
    const first = await grant();
    expect(chainFor(rootZcapId(SPACE))).toEqual([rootZcapId(SPACE)]);
    expect(first.proof.capabilityChain).toEqual([rootZcapId(SPACE)]);
    const second = await grant(app, bob, { parent: first, invocationTarget: `${SPACE}c/r` });
    expect(second.proof.capabilityChain).toEqual([rootZcapId(SPACE), first]);
    const third = await grant(bob, alice, { parent: second, invocationTarget: `${SPACE}c/r` });
    expect(third.proof.capabilityChain).toEqual([rootZcapId(SPACE), first.id, second]);
  });
});

describe('verifyDelegationChain', () => {
  it('accepts a good chain, root first', async () => {
    const first = await grant();
    const second = await grant(app, bob, {
      parent: first,
      invocationTarget: `${SPACE}c/r`,
      expires: '2026-12-01T00:00:00Z',
      created: '2026-11-05T11:30:00Z',
    });
    const result = await verifyDelegationChain(second, context());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chain.map((zcap) => zcap.id)).toEqual([rootZcapId(SPACE), first.id, second.id]);
    }
  });

  it('names why it refused', async () => {
    const reason = async (zcap: DelegatedZcap, ctx = context()): Promise<string> => {
      const result = await verifyDelegationChain(zcap, ctx);

      return result.ok ? 'ok' : result.reason;
    };

    expect(await reason(await grant())).toBe('ok');
    expect(await reason(await grant(bob))).toBe('delegator-not-controller');
    expect(await reason({ ...(await grant()), controller: bob.did })).toBe('bad-proof');
    expect(await reason(await grant(alice, app, { expires: '2026-11-05T11:00:00Z' }))).toBe('expired');
    expect(await reason(await grant(), context({ rootCapability: () => undefined }))).toBe(
      'root-not-accepted',
    );
    expect(await reason(await grant(), context({ maxChainLength: 1 }))).toBe('too-long');
    expect(await reason(await grant(), context({ isRevoked: async () => true }))).toBe('revoked');
    const wider = await grant(alice, app, { invocationTarget: 'https://example.com/other/' });
    expect(await reason(wider)).toBe('attenuation');
  });

  it('refuses an incoherent chain: a parent swapped in, a cycle, a missing embedded parent', async () => {
    const first = await grant();
    const second = await grant(app, bob, {
      parent: first,
      invocationTarget: `${SPACE}c/r`,
      expires: '2026-12-01T00:00:00Z',
    });
    const other = await grant(alice, carolLike(), { id: 'urn:uuid:other' });

    const swapped = { ...second, proof: { ...second.proof, capabilityChain: [rootZcapId(SPACE), other] } };
    expect((await verifyDelegationChain(swapped as DelegatedZcap, context())).ok).toBe(false);

    const idOnly = { ...second, proof: { ...second.proof, capabilityChain: [rootZcapId(SPACE), first.id] } };
    expect((await verifyDelegationChain(idOnly as unknown as DelegatedZcap, context())).ok).toBe(false);

    const selfParent = { ...first, parentCapability: first.id };
    expect((await verifyDelegationChain(selfParent, context())).ok).toBe(false);
  });
});

function carolLike() {
  return bob;
}

describe('authorizeInvocation', () => {
  const base = {
    signatureCreated: Math.floor(NOW.getTime() / 1000),
    requestTarget: `${SPACE}c/r`,
    action: 'GET',
  };

  it('authorizes the root capability for its controller only', async () => {
    const input = (invoker: typeof alice) => ({
      ...base,
      parsed: { rootId: rootZcapId(SPACE), action: 'GET' },
      invoker: { did: invoker.did, keyId: invoker.keyId },
    });
    expect((await authorizeInvocation(input(alice), context())).ok).toBe(true);
    const stranger = await authorizeInvocation(input(bob), context());
    expect(stranger.ok ? 'ok' : stranger.reason).toBe('invoker-not-controller');
  });

  it('matches a controller named by DID or by key id', async () => {
    const byKey = context({
      rootCapability: (id) => ({
        '@context': ZCAP_CONTEXT,
        id,
        controller: alice.keyId,
        invocationTarget: SPACE,
      }),
    });
    const result = await authorizeInvocation(
      {
        ...base,
        parsed: { rootId: rootZcapId(SPACE), action: 'GET' },
        invoker: { did: alice.did, keyId: alice.keyId },
      },
      byKey,
    );
    expect(result.ok).toBe(true);
  });
});

describe('Capability-Invocation header: one pass, however hostile', () => {
  it('keeps a comma that is inside a quoted value and splits on the ones outside', () => {
    expect(parseCapabilityInvocation('zcap id="urn:zcap:root:a%2Cb,c",action="GET"')).toMatchObject({
      rootId: 'urn:zcap:root:a%2Cb,c',
      action: 'GET',
    });
  });

  it('is malformed with an odd quote, an empty part or a trailing comma', () => {
    for (const value of [
      'zcap id="x,action="GET"',
      'zcap id="x",,action="GET"',
      'zcap id="x",action="GET",',
    ]) {
      expect(() => parseCapabilityInvocation(value)).toThrow(ZcapError);
    }
  });

  it('parses a hostile 15 kB header in linear time', () => {
    const started = performance.now();
    for (const value of [`zcap ${','.repeat(15000)}"`, `zcap x="${','.repeat(15000)}"`]) {
      expect(() => parseCapabilityInvocation(value)).toThrow(ZcapError);
    }

    // The lookahead split this replaced took about 500 ms for the pair; one pass takes a millisecond or two.
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('an embedded parent whose own chain holds something that is neither an id nor a capability', () => {
  it('is refused by checkDelegatedZcap', async () => {
    const first = await grant();
    for (const entry of [null, 5, false, []]) {
      const bad = { ...first, proof: { ...first.proof, capabilityChain: [entry] } };
      expect(() => checkDelegatedZcap(bad)).toThrow(ZcapError);
    }
  });

  it('is a malformed chain, never an exception, below a longer chain', async () => {
    const first = await grant();
    const second = await grant(app, bob, {
      parent: first,
      invocationTarget: `${SPACE}c/r`,
      expires: '2026-12-01T00:00:00Z',
    });
    for (const entry of [null, 5, false, [], {}]) {
      const poisonedParent = { ...first, proof: { ...first.proof, capabilityChain: [entry] } };
      const poisoned = {
        ...second,
        proof: { ...second.proof, capabilityChain: [rootZcapId(SPACE), poisonedParent] },
      };
      expect(await verifyDelegationChain(poisoned as unknown as DelegatedZcap, context())).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});
