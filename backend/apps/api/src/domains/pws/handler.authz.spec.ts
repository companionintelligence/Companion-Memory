import { gzipSync } from 'node:zlib';

import { ORIGIN, World, alice, app, bob, carol } from './__tests__/testKit';
import type { Identity } from './__tests__/testKit';
import { signRequest } from './httpSignature';
import { delegateCapability, formatCapabilityInvocation, rootZcapId } from './zcap';
import type { DelegatedZcap } from './zcap';

const S = 'space-1';
const C = 'docs';

async function world(config: ConstructorParameters<typeof World>[0] = {}): Promise<World> {
  const w = new World(config);
  await w.createSpace(alice, S);
  await w.createCollection(alice, S, C);
  await w.putResource(alice, S, C, 'a', { n: 'a' });
  await w.putResource(alice, S, C, 'b', { n: 'b' });
  return w;
}

const read = (w: World, grant: DelegatedZcap, as: Identity, path = `space/${S}/${C}/a`, method = 'GET') =>
  w.send({ method, path, as, via: grant });

describe('signature layer: failures describe the request (400) and never depend on the target', () => {
  /** A signed GET whose headers the caller may alter before it is handled. */
  async function signedGet(
    w: World,
    path: string,
    edit: (headers: Record<string, string>) => void = () => undefined,
    options: { created?: number; expires?: number; as?: Identity } = {},
  ) {
    const url = w.url(path);
    const as = options.as ?? alice;
    const headers = await signRequest({
      method: 'GET',
      url,
      headers: {},
      signer: as.signer,
      created: options.created ?? Math.floor(w.now.getTime() / 1000),
      ...(options.expires !== undefined ? { expires: options.expires } : {}),
      capabilityInvocation: formatCapabilityInvocation({ rootId: rootZcapId(url), action: 'GET' }),
    });
    edit(headers);
    return w.handler.handle({ method: 'GET', url, headers });
  }

  it('accepts a well-formed signed request (the control)', async () => {
    const w = await world();
    expect((await signedGet(w, `space/${S}/${C}/a`)).status).toBe(200);
  });

  const cases: Array<[string, (headers: Record<string, string>) => void]> = [
    ['a Bearer token instead of a signature', (h) => (h.authorization = 'Bearer abc')],
    [
      'a signature that does not verify',
      (h) => (h.authorization = h.authorization!.replace(/signature="[^"]{6}/, 'signature="AAAAAA')),
    ],
    ['a Host header that does not name this server', (h) => (h.host = 'evil.example')],
    ['an Authorization header with no Capability-Invocation', (h) => delete h['capability-invocation']],
    ['a Capability-Invocation header with no Authorization', (h) => delete h.authorization],
    [
      'a signature that does not cover capability-invocation',
      (h) => (h.authorization = h.authorization!.replace(' capability-invocation', '')),
    ],
    [
      'a signature that does not cover host',
      (h) => (h.authorization = h.authorization!.replace(' host', '')),
    ],
    [
      'a Capability-Invocation that changed after signing',
      (h) => (h['capability-invocation'] = h['capability-invocation']!.replace('GET', 'PUT')),
    ],
    ['an unparseable Capability-Invocation', (h) => (h['capability-invocation'] = 'zcap')],
    [
      'a Capability-Invocation with an unknown scheme',
      (h) => (h['capability-invocation'] = 'bearer id="x",action="GET"'),
    ],
    ['a content-type the signature does not cover', (h) => (h['content-type'] = 'application/json')],
  ];
  for (const [label, edit] of cases) {
    it(`rejects ${label}`, async () => {
      const w = await world();
      const res = await signedGet(w, `space/${S}/${C}/a`, edit);
      expect(res.status).toBe(400);
      expect(JSON.parse(new TextDecoder().decode(res.body)).type).toBe(
        'https://w3id.org/pws#invalid-authorization-header',
      );
    });
  }

  it('rejects a properly signed invocation whose action is not the request method', async () => {
    const w = await world();
    for (const action of ['DELETE', 'PUT', 'POST']) {
      const res = await w.send({ method: 'GET', path: `space/${S}/${C}/a`, as: alice, action });
      expect(res.status).toBe(400);
      expect(res.type).toBe('invalid-authorization-header');
    }
    expect(
      (await w.send({ method: 'HEAD', path: `space/${S}/${C}/a`, as: alice, action: 'PUT' })).status,
    ).toBe(400);
  });

  it('answers the same 400 whether or not the target exists', async () => {
    const w = await world();
    const present = await signedGet(w, `space/${S}/${C}/a`, (h) => (h.host = 'evil.example'));
    const absent = await signedGet(w, 'space/nothing/at/all', (h) => (h.host = 'evil.example'));
    expect(present.status).toBe(400);
    expect(new TextDecoder().decode(present.body)).toBe(new TextDecoder().decode(absent.body));
  });

  it('enforces the time window with the configured skew', async () => {
    const w = await world();
    const now = Math.floor(w.now.getTime() / 1000);
    expect(
      (await signedGet(w, `space/${S}/${C}/a`, undefined, { created: now - 3500, expires: now - 400 }))
        .status,
    ).toBe(400); // expired
    expect(
      (await signedGet(w, `space/${S}/${C}/a`, undefined, { created: now + 1000, expires: now + 1600 }))
        .status,
    ).toBe(400); // future
    expect(
      (await signedGet(w, `space/${S}/${C}/a`, undefined, { created: now + 100, expires: now + 700 })).status,
    ).toBe(200); // inside skew
    expect(
      (await signedGet(w, `space/${S}/${C}/a`, undefined, { created: now, expires: now + 10_000 })).status,
    ).toBe(400); // lifetime too long
  });

  it('rejects a key id it cannot resolve: another DID method, a fragment that is not the key', async () => {
    const w = await world();
    const url = w.url(`space/${S}/${C}/a`);
    const sign = async (keyId: string) => {
      const headers = await signRequest({
        method: 'GET',
        url,
        headers: {},
        signer: { id: keyId, sign: (data) => alice.signer.sign(data) },
        created: Math.floor(w.now.getTime() / 1000),
        capabilityInvocation: formatCapabilityInvocation({ rootId: rootZcapId(url), action: 'GET' }),
      });
      return w.handler.handle({ method: 'GET', url, headers });
    };
    expect((await sign('did:web:example.com#key-1')).status).toBe(400);
    expect((await sign(`${alice.did}#z6MkwrongFragment`)).status).toBe(400);
    expect((await sign(alice.did)).status).toBe(400);
  });

  it('requires the body to match its signed Digest, and the Digest to be signed', async () => {
    const w = await world();
    const tampered = await w.send({
      method: 'PUT',
      path: `space/${S}/${C}/t`,
      as: alice,
      json: { n: 'real' },
      tamperedBody: '{"n":"evil"}',
    });
    expect(tampered.status).toBe(400);
    expect(tampered.type).toBe('invalid-authorization-header');
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/t`, as: alice })).status).toBe(404);

    // signed as if bodyless, then a content-type and a correct digest attached afterwards
    const url = w.url(`space/${S}/${C}/u`);
    const headers = await signRequest({
      method: 'PUT',
      url,
      headers: {},
      signer: alice.signer,
      created: Math.floor(w.now.getTime() / 1000),
      capabilityInvocation: formatCapabilityInvocation({ rootId: rootZcapId(url), action: 'PUT' }),
    });
    const body = new TextEncoder().encode('{}');
    const { digestHeaderValue } = await import('./digest');
    const res = await w.handler.handle({
      method: 'PUT',
      url,
      headers: { ...headers, 'content-type': 'application/json', digest: digestHeaderValue(body) },
      body,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(res.body)).type).toBe(
      'https://w3id.org/pws#invalid-authorization-header',
    );
  });

  it('refuses to inflate a capability bomb', async () => {
    const w = await world();
    const url = w.url(`space/${S}/${C}/a`);
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20)).toString('base64url');
    const headers = await signRequest({
      method: 'GET',
      url,
      headers: {},
      signer: app.signer,
      created: Math.floor(w.now.getTime() / 1000),
      capabilityInvocation: `zcap capability="${bomb}",action="GET"`,
    });
    const res = await w.handler.handle({ method: 'GET', url, headers });
    expect(res.status).toBe(400);
  });
});

describe('delegation: what a capability authorizes', () => {
  it('lets a delegate read exactly what the grant covers', async () => {
    const w = await world();
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET'],
    });
    const res = await read(w, grant, app);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ n: 'a' });
    expect((await read(w, grant, app, `space/${S}/${C}/b`)).status).toBe(200);
  });

  it('refuses a request outside the grant: another Collection, another Space, a broader URL — all the masked 404', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'other');
    await w.putResource(alice, S, 'other', 'x', {});
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/a`),
      actions: ['GET'],
    });
    expect((await read(w, grant, app, `space/${S}/${C}/b`)).status).toBe(404); // a sibling
    expect((await read(w, grant, app, `space/${S}/other/x`)).status).toBe(404); // another Collection
    expect((await read(w, grant, app, `space/${S}/${C}/`)).status).toBe(404); // the parent
    expect((await read(w, grant, app, `space/${S}/${C}/a`)).status).toBe(200); // the target itself
    expect((await read(w, grant, app, `space/${S}/${C}/a/meta`)).status).toBe(200); // beneath it
  });

  it('does not let a grant for /space/s/ev reach /space/s/evil: the prefix is a path boundary', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'ev');
    await w.createCollection(alice, S, 'evil');
    await w.putResource(alice, S, 'evil', 'x', {});
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/ev`),
      actions: ['GET'],
    });
    expect((await read(w, grant, app, `space/${S}/evil/x`)).status).toBe(404);
  });

  it('refuses an action the grant does not allow, and treats HEAD as the GET it is', async () => {
    const w = await world();
    const getOnly = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET'],
    });
    expect(
      (await w.send({ method: 'PUT', path: `space/${S}/${C}/a`, as: app, via: getOnly, json: {} })).status,
    ).toBe(404);
    expect(
      (await w.send({ method: 'DELETE', path: `space/${S}/${C}/a`, as: app, via: getOnly })).status,
    ).toBe(404);
    // a client may invoke a HEAD as the GET it is authorized as
    expect(
      (await w.send({ method: 'HEAD', path: `space/${S}/${C}/a`, as: app, via: getOnly, action: 'GET' }))
        .status,
    ).toBe(200);
    // ...but the action named in the header has to be one the grant allows
    expect(
      (await w.send({ method: 'HEAD', path: `space/${S}/${C}/a`, as: app, via: getOnly, action: 'HEAD' }))
        .status,
    ).toBe(404);
    const headOnly = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['HEAD'],
    });
    expect(
      (await w.send({ method: 'HEAD', path: `space/${S}/${C}/a`, as: app, via: headOnly, action: 'HEAD' }))
        .status,
    ).toBe(200);
  });

  it('refuses an invoker who is not the capability controller', async () => {
    const w = await world();
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET'],
    });
    expect((await read(w, grant, carol)).status).toBe(404); // carol found app's capability
  });

  it('refuses an expired capability, with the configured skew', async () => {
    const w = await world();
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET'],
      expiresInSeconds: 600,
    });
    expect((await read(w, grant, app)).status).toBe(200);
    w.advance(700); // inside the 300 s skew
    expect((await read(w, grant, app)).status).toBe(200);
    w.advance(300);
    expect((await read(w, grant, app)).status).toBe(404);
  });

  describe('a capability that has expired is named so, to the one entitled to know', () => {
    const grantFor = (w: World, expiresInSeconds = 600) =>
      w.delegate({
        from: alice,
        to: app,
        spaceId: S,
        target: w.url(`space/${S}/${C}/`),
        actions: ['GET'],
        expiresInSeconds,
      });

    it('says capability-expired (still 404) to its controller, whether or not the target exists', async () => {
      const w = await world();
      const grant = await grantFor(w);
      w.advance(1000); // past the expiry and the 300 s skew
      const present = await read(w, grant, app);
      expect([present.status, present.type]).toEqual([404, 'capability-expired']);
      expect(present.header('content-type')).toBe('application/problem+json');
      const absent = await read(w, grant, app, `space/${S}/${C}/nothing`);
      expect(absent.text).toBe(present.text);
    });

    it('says the same whether or not the Collection exists, so it cannot be used to find Collections', async () => {
      const w = await world();
      // A Space-wide grant reaches every Collection id, so its holder can ask about any name.
      const grant = await w.delegate({
        from: alice,
        to: app,
        spaceId: S,
        target: w.spaceUrl(S),
        actions: ['GET'],
        expiresInSeconds: 600,
      });
      w.advance(1000);
      for (const rest of [
        'a',
        'a/meta',
        'a/policy',
        'a/chunks',
        'policy',
        'linkset',
        'backend',
        'quota',
        'meta/log',
      ]) {
        const present = await read(w, grant, app, `space/${S}/${C}/${rest}`);
        const absent = await read(w, grant, app, `space/${S}/ghost/${rest}`);
        expect([rest, present.status, present.type]).toEqual([rest, 404, 'capability-expired']);
        expect([rest, absent.status, absent.type]).toEqual([rest, 404, 'capability-expired']);
        expect(absent.text).toBe(present.text);
      }
    });

    it('names it for a chain whose parent is the expired link, and for a write the grant allowed', async () => {
      const w = await world();
      const parent = await grantFor(w, 600);
      const child = await w.delegate({
        from: app,
        to: carol,
        parent,
        target: w.url(`space/${S}/${C}/a`),
        actions: ['GET'],
        expiresInSeconds: 300,
      });
      expect((await read(w, child, carol)).status).toBe(200);
      w.advance(1000);
      expect((await read(w, child, carol)).type).toBe('capability-expired');
    });

    it('stays the plain not-found for anyone who is not the controller, or who asks for something else', async () => {
      const w = await world();
      const grant = await grantFor(w);
      w.advance(1000);
      expect((await read(w, grant, carol)).type).toBe('not-found'); // holds a copy, not the key
      expect((await read(w, grant, app, `space/${S}/elsewhere/x`)).type).toBe('not-found'); // outside the grant
      expect((await read(w, grant, app, 'space/ghost/c/x')).type).toBe('not-found');
      expect((await read(w, grant, app, `space/${S}/${C}/a`, 'DELETE')).type).toBe('not-found');
      expect((await w.send({ method: 'GET', path: `space/${S}/${C}/a` })).type).toBe('not-found');
    });

    it('lets every other defect in the chain win: an altered, forged or widened grant is not-found', async () => {
      const w = await world();
      const grant = await grantFor(w);
      const forged = await w.delegate({
        from: bob,
        to: app,
        spaceId: S,
        target: w.url(`space/${S}/${C}/`),
        actions: ['GET'],
        expiresInSeconds: 600,
      });
      const widened = { ...grant, invocationTarget: w.url(`space/${S}/`) };
      w.advance(1000);
      for (const bad of [forged, widened]) {
        expect((await read(w, bad, app)).type).toBe('not-found');
      }
      // a later link with a bad proof, below an expired one
      const second = await w.delegate({
        from: bob, // not the controller of the (expired) parent
        to: carol,
        parent: grant,
        target: w.url(`space/${S}/${C}/a`),
        actions: ['GET'],
        expiresInSeconds: 100,
      });
      expect((await read(w, second, carol)).type).toBe('not-found');
    });

    it('is not shown when a policy already lets the read through', async () => {
      const w = await world();
      const grant = await grantFor(w);
      // only `a` is public: the policy is consulted whatever became of the capability
      await w.send({
        method: 'PUT',
        path: `space/${S}/${C}/a/policy`,
        as: alice,
        root: w.spaceUrl(S),
        json: { type: 'PublicCanRead' },
      });
      w.advance(1000);
      expect((await read(w, grant, app)).status).toBe(200);
      expect((await read(w, grant, app, `space/${S}/${C}/b`)).type).toBe('capability-expired');
    });
  });

  it('refuses a delegation made by someone who does not control its parent', async () => {
    const w = await world();
    const forged = await w.delegate({
      from: bob,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET'],
    });
    expect((await read(w, forged, app)).status).toBe(404);
  });

  it('refuses a capability whose document was altered after it was signed', async () => {
    const w = await world();
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/a`),
      actions: ['GET'],
    });
    const widened = { ...grant, invocationTarget: w.url(`space/${S}/`) };
    expect((await read(w, widened, app, `space/${S}/${C}/b`)).status).toBe(404);
    const longer = { ...grant, expires: '2099-01-01T00:00:00Z' };
    expect((await read(w, longer, app)).status).toBe(404);
    expect((await read(w, longer, app)).type).toBe('not-found');
  });

  it('refuses a capability rooted at a Space that is not this one, or at the whole origin', async () => {
    const w = await world();
    await w.createSpace(bob, 'bobs');
    const grantFromBob = await w.delegate({
      from: bob,
      to: app,
      spaceId: 'bobs',
      target: w.url('space/bobs/'),
      actions: ['GET'],
    });
    expect((await read(w, grantFromBob, app)).status).toBe(404);
    const originRoot = await delegateCapability({
      parent: rootZcapId(`${ORIGIN}/`),
      signer: alice.signer,
      controller: app.did,
      invocationTarget: `${ORIGIN}/`,
      allowedAction: ['GET'],
      expires: w.iso(3600),
      created: w.iso(),
    });
    expect((await read(w, originRoot, app)).status).toBe(404);
  });

  describe('chains', () => {
    it('honours a two-link chain that narrows at each step', async () => {
      const w = await world();
      const first = await w.delegate({
        from: alice,
        to: app,
        spaceId: S,
        target: w.url(`space/${S}/${C}/`),
        actions: ['GET', 'PUT'],
      });
      const second = await w.delegate({
        from: app,
        to: carol,
        parent: first,
        target: w.url(`space/${S}/${C}/a`),
        actions: ['GET'],
      });
      expect((await read(w, second, carol)).status).toBe(200);
      expect((await read(w, second, carol, `space/${S}/${C}/b`)).status).toBe(404);
    });

    it('refuses a link that widens its parent: target, action, or lifetime', async () => {
      const w = await world();
      const first = await w.delegate({
        from: alice,
        to: app,
        spaceId: S,
        target: w.url(`space/${S}/${C}/a`),
        actions: ['GET'],
        expiresInSeconds: 3600,
      });
      const widerTarget = await w.delegate({
        from: app,
        to: carol,
        parent: first,
        target: w.url(`space/${S}/${C}/`),
        actions: ['GET'],
        expiresInSeconds: 1800,
      });
      const widerAction = await w.delegate({
        from: app,
        to: carol,
        parent: first,
        target: w.url(`space/${S}/${C}/a`),
        actions: ['GET', 'PUT'],
        expiresInSeconds: 1800,
      });
      const longer = await w.delegate({
        from: app,
        to: carol,
        parent: first,
        target: w.url(`space/${S}/${C}/a`),
        actions: ['GET'],
        expiresInSeconds: 7200,
      });
      // each request is one the widened link would allow and the parent does not
      expect((await read(w, widerTarget, carol, `space/${S}/${C}/b`)).status).toBe(404);
      expect(
        (await w.send({ method: 'PUT', path: `space/${S}/${C}/a`, as: carol, via: widerAction, json: {} }))
          .status,
      ).toBe(404);
      // the child's lifetime (2 h) runs past its parent's (1 h): refused now, before anything has expired
      expect((await read(w, longer, carol)).status).toBe(404);
      // and a link that does not widen is accepted, so the refusals above are about widening and nothing else
      const narrower = await w.delegate({
        from: app,
        to: carol,
        parent: first,
        target: w.url(`space/${S}/${C}/a`),
        actions: ['GET'],
        expiresInSeconds: 1800,
      });
      expect((await read(w, narrower, carol)).status).toBe(200);
    });

    it('refuses an invocation made before the delegation it relies on', async () => {
      const w = await world();
      const grant = await w.delegate({
        from: alice,
        to: app,
        spaceId: S,
        target: w.url(`space/${S}/${C}/`),
        actions: ['GET'],
      });
      const now = Math.floor(w.now.getTime() / 1000);
      const early = await w.send({
        method: 'GET',
        path: `space/${S}/${C}/a`,
        as: app,
        via: grant,
        created: now - 400,
        expires: now + 100,
      });
      expect(early.status).toBe(404);
      const fine = await w.send({
        method: 'GET',
        path: `space/${S}/${C}/a`,
        as: app,
        via: grant,
        created: now - 200,
        expires: now + 100,
      });
      expect(fine.status).toBe(200);
    });

    it('refuses a link signed by someone who is not the parent controller', async () => {
      const w = await world();
      const first = await w.delegate({
        from: alice,
        to: app,
        spaceId: S,
        target: w.url(`space/${S}/${C}/`),
        actions: ['GET'],
      });
      const stolen = await w.delegate({
        from: carol,
        to: carol,
        parent: first,
        target: w.url(`space/${S}/${C}/a`),
        actions: ['GET'],
      });
      expect((await read(w, stolen, carol)).status).toBe(404);
    });

    it('refuses a chain longer than the configured maximum', async () => {
      const w = await world({ maxChainLength: 3 });
      await w.createSpace(alice, 'ignored');
      let grant = await w.delegate({
        from: alice,
        to: app,
        spaceId: S,
        target: w.url(`space/${S}/${C}/`),
        actions: ['GET'],
      });
      expect((await read(w, grant, app)).status).toBe(200);
      const people = [app, carol, bob, alice];
      for (let i = 0; i < 3; i += 1) {
        grant = await w.delegate({
          from: people[i]!,
          to: people[i + 1]!,
          parent: grant,
          target: w.url(`space/${S}/${C}/`),
          actions: ['GET'],
        });
      }
      expect((await read(w, grant, people[3]!)).status).toBe(404);
    });
  });

  it('asks a revocation hook about every delegated capability in the chain', async () => {
    const revoked = new Set<string>();
    const w = await world({ isRevoked: async (id) => revoked.has(id) });
    const first = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET'],
      id: 'urn:uuid:first',
    });
    const second = await w.delegate({
      from: app,
      to: carol,
      parent: first,
      target: w.url(`space/${S}/${C}/a`),
      actions: ['GET'],
      id: 'urn:uuid:second',
    });
    expect((await read(w, second, carol)).status).toBe(200);
    revoked.add('urn:uuid:first');
    expect((await read(w, second, carol)).status).toBe(404); // revoking a parent withdraws everything below it
    expect((await read(w, first, app)).status).toBe(404);
  });

  describe('root capabilities', () => {
    it('accepts the root of the request URL itself, of the Space, and of any ancestor in the Space', async () => {
      const w = await world();
      for (const root of [w.url(`space/${S}/${C}/a`), w.url(`space/${S}/${C}/`), w.url(`space/${S}/`)]) {
        expect((await w.send({ method: 'GET', path: `space/${S}/${C}/a`, as: alice, root })).status).toBe(
          200,
        );
      }
    });

    it('refuses the root of another Space, of a deeper URL, or of the origin', async () => {
      const w = await world();
      await w.createSpace(alice, 'second');
      for (const root of [
        w.url('space/second/'),
        w.url(`space/${S}/${C}/b`),
        `${ORIGIN}/`,
        `${ORIGIN}/space/`,
      ]) {
        expect((await w.send({ method: 'GET', path: `space/${S}/${C}/a`, as: alice, root })).status).toBe(
          404,
        );
      }
    });

    it('does not let a stranger use the controller’s root', async () => {
      const w = await world();
      expect(
        (await w.send({ method: 'GET', path: `space/${S}/${C}/a`, as: bob, root: w.url(`space/${S}/`) }))
          .status,
      ).toBe(404);
    });
  });
});

describe('ordering: authorize first, then report anything about the target', () => {
  it('answers a stranger 404 where an authorized caller would see 409, 400, 501 or 413', async () => {
    const w = new World({ maxUploadBytes: 8 });
    await w.createSpace(alice, S);
    await w.createCollection(alice, S, C);

    const dup = { method: 'POST', path: `space/${S}/`, json: { id: C } };
    expect((await w.send({ ...dup, as: bob })).status).toBe(404);
    expect((await w.send({ ...dup, as: alice, root: w.spaceUrl(S) })).status).toBe(409);

    const cursor = { method: 'GET', path: `space/${S}/${C}/?cursor=!!` };
    expect((await w.send({ ...cursor, as: bob })).status).toBe(404);
    expect((await w.send({ ...cursor, as: alice, root: w.spaceUrl(S) })).status).toBe(400);

    const big = {
      method: 'PUT',
      path: `space/${S}/${C}/big`,
      body: new Uint8Array(64),
      contentType: 'application/octet-stream',
    };
    expect((await w.send({ ...big, as: bob })).status).toBe(404);
    expect((await w.send({ ...big, as: alice, root: w.spaceUrl(S) })).status).toBe(413);

    for (const path of [
      `space/${S}/quotas`,
      `space/${S}/backends`,
      `space/${S}/${C}/quota`,
      `space/${S}/${C}/query`,
    ]) {
      const method = path.endsWith('query') ? 'POST' : 'GET';
      expect((await w.send({ method, path, as: bob, json: method === 'POST' ? {} : undefined })).status).toBe(
        404,
      );
      const owner = await w.send({
        method,
        path,
        as: alice,
        root: w.spaceUrl(S),
        json: method === 'POST' ? { profile: 'changes' } : undefined,
      });
      expect(owner.status).toBe(501);
      expect(owner.type).toBe('unsupported-operation');
    }
  });

  it('does not delete, write or seize anything for a stranger', async () => {
    const w = await world();
    await w.send({ method: 'DELETE', path: `space/${S}/${C}/a`, as: bob });
    await w.send({ method: 'DELETE', path: `space/${S}/${C}/`, as: bob });
    await w.send({ method: 'DELETE', path: `space/${S}/`, as: bob });
    await w.store.transaction(async (tx) => {
      expect(await tx.getResource(S, C, 'a')).toBeDefined();
      expect(await tx.getCollection(S, C)).toBeDefined();
      expect(await tx.getSpace(S)).toBeDefined();
    });
  });
});

describe('policies', () => {
  const policy = (w: World, path: string, json: unknown, method = 'PUT', as: Identity = alice) =>
    w.send({ method, path, as, root: w.spaceUrl(S), ...(json === undefined ? {} : { json }) });

  it('keeps everything private by default: an anonymous GET is 404', async () => {
    const w = await world();
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/a` })).status).toBe(404);
  });

  it('makes a Collection publicly readable with PublicCanRead; the PUT is 201 then 204', async () => {
    const w = await world();
    expect((await policy(w, `space/${S}/${C}/policy`, { type: 'PublicCanRead' })).status).toBe(201);
    expect((await policy(w, `space/${S}/${C}/policy`, { type: 'PublicCanRead' })).status).toBe(204);
    const anonymous = await w.send({ method: 'GET', path: `space/${S}/${C}/a` });
    expect(anonymous.status).toBe(200);
    expect(anonymous.json).toEqual({ n: 'a' });
    expect(anonymous.header('cache-control')).toBe('public, no-cache');
    expect(
      (await w.send({ method: 'GET', path: `space/${S}/${C}/a`, as: alice, root: w.spaceUrl(S) })).header(
        'cache-control',
      ),
    ).toBe('private, no-cache');
  });

  it('falls back to the policy when a valid capability does not authorize the read', async () => {
    const w = await world();
    await policy(w, `space/${S}/${C}/policy`, { type: 'PublicCanRead' });
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/a`, as: bob })).status).toBe(200);
  });

  it('grants reads only: a write to a public target is 401 for an anonymous caller and 404 for a stranger', async () => {
    const w = await world();
    await policy(w, `space/${S}/${C}/policy`, { type: 'PublicCanRead' });
    const anonymous = await w.send({ method: 'PUT', path: `space/${S}/${C}/a`, json: { n: 'hacked' } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.type).toBe('missing-authorization');
    expect((await w.send({ method: 'PUT', path: `space/${S}/${C}/a`, as: bob, json: {} })).status).toBe(404);
    expect((await w.send({ method: 'DELETE', path: `space/${S}/${C}/a` })).status).toBe(401);
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/a` })).json).toEqual({ n: 'a' });
  });

  it('answers an anonymous write 401 even when the target is private: nothing stored shows in the answer', async () => {
    const w = await world();
    expect((await w.send({ method: 'PUT', path: `space/${S}/${C}/a`, json: {} })).status).toBe(401);
  });

  it('never makes the policy itself public', async () => {
    const w = await world();
    await policy(w, `space/${S}/${C}/policy`, { type: 'PublicCanRead' });
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/policy` })).status).toBe(404);
    expect((await policy(w, `space/${S}/${C}/policy`, undefined, 'GET')).json).toEqual({
      type: 'PublicCanRead',
    });
    expect(
      (
        await w.send({
          method: 'PUT',
          path: `space/${S}/${C}/policy`,
          as: bob,
          json: { type: 'PublicCanRead' },
        })
      ).status,
    ).toBe(404);
  });

  it('can be set on a Resource, and on the Space (inherited by everything under it)', async () => {
    const w = await world();
    await policy(w, `space/${S}/${C}/a/policy`, { type: 'PublicCanRead' });
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/a` })).status).toBe(200);
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/b` })).status).toBe(404);
    await policy(w, `space/${S}/policy`, { type: 'PublicCanRead' });
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/b` })).status).toBe(200);
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/` })).status).toBe(200);
  });

  it('revokes public access when the policy is deleted; DELETE is idempotent', async () => {
    const w = await world();
    await policy(w, `space/${S}/${C}/policy`, { type: 'PublicCanRead' });
    expect((await policy(w, `space/${S}/${C}/policy`, undefined, 'DELETE')).status).toBe(204);
    expect((await policy(w, `space/${S}/${C}/policy`, undefined, 'DELETE')).status).toBe(204);
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/a` })).status).toBe(404);
  });

  it('refuses a policy it would not enforce, and a policy for something that is not there', async () => {
    const w = await world();
    for (const body of [{ type: 'AuthenticatedCanRead' }, { type: '' }, {}, { type: 3 }]) {
      expect((await policy(w, `space/${S}/${C}/policy`, body)).type).toBe('invalid-request-body');
    }
    expect((await policy(w, `space/${S}/nothing/policy`, { type: 'PublicCanRead' })).status).toBe(404);
    expect((await policy(w, `space/${S}/${C}/ghost/policy`, { type: 'PublicCanRead' })).status).toBe(404);
  });

  it('can be administered through a delegated capability that covers it', async () => {
    const w = await world();
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['PUT'],
    });
    expect(
      (
        await w.send({
          method: 'PUT',
          path: `space/${S}/${C}/policy`,
          as: app,
          via: grant,
          json: { type: 'PublicCanRead' },
        })
      ).status,
    ).toBe(201);
  });

  it('advertises itself in the linkset, which is as public as the target it describes', async () => {
    const w = await world();
    expect((await w.send({ method: 'GET', path: `space/${S}/${C}/linkset` })).status).toBe(404);
    await policy(w, `space/${S}/${C}/policy`, { type: 'PublicCanRead' });
    const res = await w.send({ method: 'GET', path: `space/${S}/${C}/linkset` });
    expect(res.status).toBe(200);
    expect(res.header('content-type')).toBe('application/linkset+json');
    expect(res.json.linkset[0].anchor).toBe(`/space/${S}/${C}/`);
    expect(res.json.linkset[0]['https://w3id.org/pws#policy'][0].href).toBe(`/space/${S}/${C}/policy`);
    expect(res.json.linkset[0].service[0].href).toBe(`${ORIGIN}/service`);
  });

  it('shows a public Collection to anonymous listers with public: true', async () => {
    const w = await world();
    await policy(w, `space/${S}/policy`, { type: 'PublicCanRead' });
    await policy(w, `space/${S}/${C}/policy`, { type: 'PublicCanRead' });
    const list = await w.send({ method: 'GET', path: `space/${S}/` });
    expect(list.json.items[0].public).toBe(true);
  });
});

describe('routes, methods and transport', () => {
  it('answers 405 with Allow at a container URL and at reserved endpoints, whether or not the Space exists', async () => {
    const w = await world();
    for (const [method, path, allow] of [
      ['PUT', `space/${S}/`, 'GET, HEAD, POST, DELETE'],
      ['PUT', `space/${S}/${C}/`, 'GET, HEAD, POST, DELETE'],
      ['DELETE', `space/${S}/meta`, 'GET, HEAD, PUT'],
      ['POST', `space/${S}/${C}/meta`, 'GET, HEAD, PUT'],
      ['POST', `space/${S}/${C}/a`, 'GET, HEAD, PUT, DELETE'],
      ['PATCH', `space/${S}/${C}/a`, 'GET, HEAD, PUT, DELETE'],
      ['POST', `space/${S}/linkset`, 'GET, HEAD'],
    ] as const) {
      const res = await w.send({ method, path, as: alice, root: w.spaceUrl(S), json: {} });
      expect(res.status).toBe(405);
      expect(res.header('allow')).toBe(allow);
    }
    const existing = await w.send({ method: 'PUT', path: `space/${S}/`, as: alice, json: {} });
    const missing = await w.send({ method: 'PUT', path: 'space/ghost/', as: bob, json: {} });
    const anonymous = await w.send({ method: 'PUT', path: 'space/ghost/', json: {} });
    expect(existing.text).toBe(missing.text);
    expect(existing.text).toBe(anonymous.text);
  });

  it('redirects the other spelling of a canonical URL with 308 to a root-relative Location, keeping the query', async () => {
    const w = await world();
    for (const [from, to] of [
      [`space/${S}`, `/space/${S}/`],
      [`space/${S}/${C}`, `/space/${S}/${C}/`],
      [`space/${S}/${C}/a/`, `/space/${S}/${C}/a`],
      [`space/${S}/${C}/meta/`, `/space/${S}/${C}/meta`],
      [`space/${S}/${C}?limit=2`, `/space/${S}/${C}/?limit=2`],
      ['spaces', '/spaces/'],
      [`space/${S}/collections/`, `/space/${S}/`],
      [`space/${S}/collections`, `/space/${S}/`],
    ]) {
      const res = await w.send({ method: 'GET', path: from });
      expect(res.status).toBe(308);
      expect(res.header('location')).toBe(to);
      expect(res.header('link')).toBe(`<${ORIGIN}/service>; rel="service"`);
    }
  });

  it('routes nothing else: unknown paths, empty segments, escapes and dot segments', async () => {
    const w = await world();
    for (const path of [
      'nothing',
      'space/',
      'space//x/',
      `space/${S}/${C}//a`,
      `space/${S}/%61/`,
      `space/${S}/policy/meta`,
      `space/${S}/${C}/a/other`,
      `space/${S}/${C}/a/meta/more`,
      // dot segments, whatever their spelling, are not resolved into another route
      `space/${S}/${C}/../${C}/a`,
      `space/${S}/${C}/./a`,
      `space/${S}/${C}/%2e%2e/${C}/a`,
      `space/${S}/${C}/..\\${C}/a`,
    ]) {
      const res = await w.send({ method: 'GET', path, as: alice, root: w.spaceUrl(S) });
      expect([path, res.status]).toEqual([path, 404]);
    }
    const bad = await w.send({ method: 'GET', path: 'space/has%20space/', as: alice });
    expect(bad.status).toBe(404);
  });

  it('answers a path-segment id that cannot be an id with 400 invalid-id', async () => {
    const w = await world();
    const res = await w.send({ method: 'GET', path: `space/${'x'.repeat(200)}/` });
    expect(res.status).toBe(400);
    expect(res.type).toBe('invalid-id');
  });

  it('serves the service description to anyone, and puts its Link on every response', async () => {
    const w = await world();
    const sd = await w.send({ method: 'GET', path: 'service' });
    expect(sd.status).toBe(200);
    expect(sd.header('access-control-allow-origin')).toBe('*');
    expect(sd.header('cache-control')).toBe('public, max-age=3600');
    expect(sd.json).toEqual({
      url: `${ORIGIN}/service`,
      specs: {
        'https://w3id.org/pws': [
          {
            version: '0.5',
            url: 'https://w3c-ccg.github.io/portable-web-spaces-spec/',
            spaces: `${ORIGIN}/spaces/`,
            features: [
              'listing',
              'collection-management',
              'space-management',
              'linksets',
              'policy',
              'metadata',
              'created-by',
            ],
            originId: 'test-origin',
          },
        ],
        'https://w3id.org/pws/authz-profile': [
          {
            version: '0.1',
            url: 'https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/',
            signatureAlgorithms: ['EdDSA'],
            zcapCryptosuites: ['eddsa-jcs-2022'],
          },
        ],
      },
    });
    // it never claims a method it refuses
    expect(sd.text).not.toContain('keri');
    const again = await w.send({
      method: 'GET',
      path: 'service',
      headers: { 'if-none-match': sd.header('etag') as string },
    });
    expect(again.status).toBe(304);

    const link = `<${ORIGIN}/service>; rel="service"`;
    const responses = [
      await w.send({ method: 'GET', path: `space/${S}/${C}/a` }), // 404
      await w.send({ method: 'POST', path: 'spaces/', json: {} }), // 401
      await w.send({ method: 'PUT', path: `space/${S}/`, json: {} }), // 405
      await w.send({ method: 'GET', path: `space/${S}` }), // 308
      await w.send({ method: 'OPTIONS', path: `space/${S}/` }), // 204
      await w.send({ method: 'GET', path: 'service' }), // 200
      await w.send({ method: 'HEAD', path: 'service' }),
      await w.send({
        method: 'GET',
        path: `space/${S}/${C}/a`,
        as: alice,
        headers: { host: 'wrong' },
        strip: [],
      }),
    ];
    for (const res of responses) {
      expect(res.header('link')).toBe(link);
      expect(res.header('access-control-expose-headers')).toContain('Link');
    }
  });

  it('answers a CORS preflight without a credential', async () => {
    const w = await world();
    const res = await w.send({ method: 'OPTIONS', path: `space/${S}/${C}/a` });
    expect(res.status).toBe(204);
    expect(res.header('access-control-allow-methods')).toContain('PUT');
    expect(res.header('access-control-allow-headers')).toContain('capability-invocation');
    expect(res.header('access-control-allow-origin')).toBe('*');
  });

  it('is mountable under a path: URLs, Links and capabilities all carry it', async () => {
    const w = new World({ baseUrl: `${ORIGIN}/pws/` });
    const res = await w.send({
      method: 'POST',
      path: 'pws/spaces/',
      as: alice,
      json: { id: 'mounted', controller: alice.did },
    });
    expect(res.status).toBe(201);
    expect(res.header('location')).toBe(`${ORIGIN}/pws/space/mounted/`);
    expect(res.json.url).toBe('/pws/space/mounted/');
    expect(res.header('link')).toBe(`<${ORIGIN}/pws/service>; rel="service"`);
    expect((await w.send({ method: 'GET', path: 'space/mounted/meta', as: alice })).status).toBe(404); // outside the mount
  });

  it('never leaks internals: an unexpected failure is a generic 500 and is reported to the hook', async () => {
    const errors: unknown[] = [];
    const w = await world({ onError: (error) => errors.push(error) });
    jest.spyOn(w.store, 'transaction').mockRejectedValueOnce(new Error('database password is hunter2'));
    const res = await w.send({ method: 'GET', path: `space/${S}/${C}/a`, as: alice, root: w.spaceUrl(S) });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('hunter2');
    expect(errors).toHaveLength(1);
  });
});

describe('a grant is compared with the URL as the router reads it', () => {
  it('is not widened by dot segments, in any spelling, for any method', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'other');
    await w.putResource(alice, S, 'other', 'x', { n: 'x' });
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET', 'PUT', 'POST', 'DELETE'],
    });
    expect((await read(w, grant, app, `space/${S}/${C}/a`)).status).toBe(200); // the control
    const send = (method: string, path: string, json?: unknown) =>
      w.send({ method, path, as: app, via: grant, ...(json === undefined ? {} : { json }) });
    for (const dots of ['..', '%2e%2e', '%2E%2E', '.%2e', '%2e.', '..\\']) {
      const base = `space/${S}/${C}/${dots}`;
      for (const [method, path, json] of [
        ['GET', `${base}/other/x`],
        ['GET', `${base}/meta`],
        ['GET', `${base}/`],
        ['PUT', `${base}/other/planted`, { n: 'planted' }],
        ['DELETE', `${base}/other/x`],
        ['POST', `${base}/`, { id: 'sneaky' }],
        ['PUT', `${base}/policy`, { type: 'PublicCanRead' }],
      ] as Array<[string, string, unknown?]>) {
        const res = await send(method, path, json);
        expect([method, path, res.status]).toEqual([method, path, 404]);
      }
    }
    // nothing was read, written, deleted or made public
    expect(
      (await w.send({ method: 'GET', path: `space/${S}/other/x`, as: alice, root: w.spaceUrl(S) })).json,
    ).toEqual({
      n: 'x',
    });
    expect(
      (await w.send({ method: 'GET', path: `space/${S}/other/planted`, as: alice, root: w.spaceUrl(S) }))
        .status,
    ).toBe(404);
    expect(
      (await w.send({ method: 'GET', path: `space/${S}/sneaky/meta`, as: alice, root: w.spaceUrl(S) }))
        .status,
    ).toBe(404);
    expect((await w.send({ method: 'GET', path: `space/${S}/other/x` })).status).toBe(404);
    expect((await w.send({ method: 'GET', path: `space/${S}/meta` })).status).toBe(404);
  });

  it('compares the canonical URL, so the spelling of the scheme and host does not matter', async () => {
    const w = await world();
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET'],
    });
    const url = `HTTPS://EXAMPLE.COM/space/${S}/${C}/a`;
    const headers = await signRequest({
      method: 'GET',
      url,
      headers: {},
      signer: app.signer,
      created: Math.floor(w.now.getTime() / 1000),
      capabilityInvocation: formatCapabilityInvocation({ capability: grant, action: 'GET' }),
    });
    const res = await w.handler.handle({ method: 'GET', url, headers });
    expect(res.status).toBe(200);
  });
});

describe('a malformed capability is the masked 404 for every target alike', () => {
  it('answers the same for an existing and an absent target, and never reaches onError', async () => {
    const errors: unknown[] = [];
    const w = await world({ onError: (e) => errors.push(e) });
    const first = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET'],
    });
    const second = await w.delegate({
      from: app,
      to: bob,
      parent: first,
      target: w.url(`space/${S}/${C}/a`),
      actions: ['GET'],
    });
    for (const entry of [null, 5, false, [], {}]) {
      const poisonedParent = { ...first, proof: { ...first.proof, capabilityChain: [entry] } };
      const forged = {
        ...second,
        proof: { ...second.proof, capabilityChain: [rootZcapId(w.spaceUrl(S)), poisonedParent] },
      } as unknown as DelegatedZcap;
      for (const [method, present, absent] of [
        ['GET', `space/${S}/`, 'space/ghost/'],
        ['DELETE', `space/${S}/`, 'space/ghost/'],
        ['GET', `space/${S}/meta`, 'space/ghost/meta'],
        ['GET', `space/${S}/${C}/a`, `space/${S}/nope/a`],
        ['GET', `space/${S}/${C}/policy`, `space/${S}/nope/policy`],
        ['PUT', `space/${S}/${C}/zzz`, `space/${S}/nope/zzz`],
      ] as const) {
        const json = method === 'PUT' ? { n: 1 } : undefined;
        const there = await w.send({
          method,
          path: present,
          as: bob,
          via: forged,
          ...(json ? { json } : {}),
        });
        const gone = await w.send({ method, path: absent, as: bob, via: forged, ...(json ? { json } : {}) });
        expect([method, present, there.status, there.type]).toEqual([method, present, 404, 'not-found']);
        expect(gone.text).toBe(there.text);
      }
    }
    expect(errors).toEqual([]);
  });
});
