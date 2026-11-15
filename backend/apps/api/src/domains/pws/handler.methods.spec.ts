import { World, alice, bob } from './__tests__/testKit';

const S = 'space-1';
const C = 'messages';

async function world(): Promise<World> {
  const w = new World();
  await w.createSpace(alice, S);
  await w.createCollection(alice, S, C);
  await w.putResource(alice, S, C, 'a', { n: 'a' });

  return w;
}

/** [path, a method the endpoint does not define, the `Allow` header that answers it]. */
const NOT_DEFINED: Array<[string, string, string]> = [
  ['', 'POST', 'GET, HEAD'],
  ['service', 'PUT', 'GET, HEAD'],
  ['spaces/', 'DELETE', 'GET, HEAD, POST'],
  [`space/${S}/`, 'PUT', 'GET, HEAD, POST, DELETE'],
  [`space/${S}/meta`, 'POST', 'GET, HEAD, PUT'],
  [`space/${S}/linkset`, 'PUT', 'GET, HEAD'],
  [`space/${S}/policy`, 'POST', 'GET, HEAD, PUT, DELETE'],
  [`space/${S}/collections`, 'DELETE', 'GET, HEAD, POST'],
  [`space/${S}/backends`, 'POST', 'GET, HEAD'],
  [`space/${S}/quotas`, 'POST', 'GET, HEAD'],
  [`space/${S}/export`, 'GET', 'POST'],
  [`space/${S}/import`, 'GET', 'POST'],
  [`space/${S}/query`, 'GET', 'POST'],
  [`space/${S}/${C}/`, 'PUT', 'GET, HEAD, POST, DELETE'],
  [`space/${S}/${C}/meta`, 'DELETE', 'GET, HEAD, PUT'],
  [`space/${S}/${C}/meta/log`, 'DELETE', 'GET, HEAD, PUT'],
  [`space/${S}/${C}/linkset`, 'POST', 'GET, HEAD'],
  [`space/${S}/${C}/policy`, 'POST', 'GET, HEAD, PUT, DELETE'],
  [`space/${S}/${C}/backend`, 'POST', 'GET, HEAD'],
  [`space/${S}/${C}/quota`, 'POST', 'GET, HEAD'],
  [`space/${S}/${C}/query`, 'GET', 'POST'],
  [`space/${S}/${C}/a`, 'POST', 'GET, HEAD, PUT, DELETE'],
  [`space/${S}/${C}/a/meta`, 'DELETE', 'GET, HEAD, PUT'],
  [`space/${S}/${C}/a/policy`, 'POST', 'GET, HEAD, PUT, DELETE'],
  [`space/${S}/${C}/a/chunks/`, 'PUT', 'GET, HEAD'],
  [`space/${S}/${C}/a/chunks/c1`, 'POST', 'GET, HEAD, PUT, DELETE'],
];

describe('methods an endpoint does not define: 405 before anything that depends on state', () => {
  it.each(NOT_DEFINED)('%s answers %s with 405 and Allow: %s', async (path, method, allow) => {
    const w = await world();
    const callers = [{}, { as: bob }, { as: alice, root: w.spaceUrl(S) }];
    const bodies = new Set<string>();
    for (const caller of callers) {
      for (const target of [path, path.replace(S, 'ghost')]) {
        const res = await w.send({ method, path: target, ...caller });
        expect(res.status).toBe(405);
        expect(res.header('allow')).toBe(allow);
        expect(res.header('content-type')).toBe('application/problem+json');
        bodies.add(res.text);
      }
    }

    // an anonymous caller, a stranger, the controller, and a Space that is not there: one answer
    expect(bodies.size).toBe(1);
  });

  it('is not a way to find out what exists: HEAD, GET and OPTIONS keep their own answers', async () => {
    const w = await world();
    expect((await w.send({ method: 'OPTIONS', path: `space/${S}/` })).status).toBe(204);
    expect((await w.send({ method: 'GET', path: `space/${S}/` })).status).toBe(404);
    expect((await w.send({ method: 'HEAD', path: `space/ghost/` })).status).toBe(404);
  });
});

describe('an anonymous write is 401, and says nothing about what exists', () => {
  const WRITES: Array<[string, string]> = [
    ['POST', 'spaces/'],
    ['PUT', `space/${S}/meta`],
    ['DELETE', `space/${S}/`],
    ['POST', `space/${S}/`],
    ['PUT', `space/${S}/policy`],
    ['DELETE', `space/${S}/policy`],
    ['PUT', `space/${S}/${C}/meta`],
    ['DELETE', `space/${S}/${C}/`],
    ['POST', `space/${S}/${C}/`],
    ['PUT', `space/${S}/${C}/policy`],
    ['PUT', `space/${S}/${C}/a`],
    ['DELETE', `space/${S}/${C}/a`],
    ['PUT', `space/${S}/${C}/a/meta`],
    ['PUT', `space/${S}/${C}/a/policy`],
    ['POST', `space/${S}/export`],
    ['POST', `space/${S}/${C}/query`],
    ['PUT', `space/${S}/${C}/a/chunks/c1`],
  ];

  it.each(WRITES)('%s %s', async (method, path) => {
    const w = await world();
    const existing = await w.send({ method, path, json: {} });
    const ghost = await w.send({
      method,
      path: path.replace(S, 'ghost').replace(`/${C}/`, '/none/'),
      json: {},
    });
    expect(existing.status).toBe(401);
    expect(existing.type).toBe('missing-authorization');
    expect(existing.text).toBe(ghost.text);
    // RFC 9110 §15.5.2: a 401 offers a challenge, and this one names the scheme and what to cover
    expect(existing.header('www-authenticate')).toMatch(
      /^Signature realm="[^"]+",headers="[^"]*capability-invocation"$/,
    );
  });

  it('is only for writes: an anonymous read of a private target stays the masked 404', async () => {
    const w = await world();
    for (const path of [`space/${S}/`, `space/${S}/${C}/`, `space/${S}/${C}/a`, `space/${S}/${C}/a/meta`]) {
      const res = await w.send({ method: 'GET', path });
      expect(res.status).toBe(404);
      expect(res.header('www-authenticate')).toBeUndefined();
    }
  });

  it('leaves a signed stranger with the masked 404 it always had', async () => {
    const w = await world();
    for (const [method, path] of WRITES.filter(([m, p]) => m !== 'POST' || p !== 'spaces/')) {
      const res = await w.send({ method, path, as: bob, json: {} });
      expect([404, 501]).toContain(res.status);
      expect(res.status).not.toBe(401);
    }
  });

  it('does not reach the store: nothing is created, changed or deleted', async () => {
    const w = await world();
    await w.send({ method: 'DELETE', path: `space/${S}/`, json: {} });
    await w.send({ method: 'DELETE', path: `space/${S}/${C}/a` });
    await w.send({ method: 'PUT', path: `space/${S}/${C}/b`, json: { n: 'b' } });
    await w.store.transaction(async (tx) => {
      expect(await tx.countSpaces()).toBe(1);
      expect(await tx.getResource(S, C, 'a')).toBeDefined();
      expect(await tx.getResource(S, C, 'b')).toBeUndefined();
    });
  });
});

describe('the retired v0.4 /space/{s}/collections endpoint', () => {
  it('sends list and add to the Space URL with 308, keeping the query', async () => {
    const w = await world();
    for (const method of ['GET', 'HEAD', 'POST']) {
      for (const path of [`space/${S}/collections`, `space/${S}/collections/`]) {
        const res = await w.send({ method, path: `${path}?limit=2` });
        expect(res.status).toBe(308);
        expect(res.header('location')).toBe(`/space/${S}/?limit=2`);
      }
    }
  });

  it('refuses every other method, so a DELETE of this path can never delete the Space', async () => {
    const w = await world();
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      for (const as of [undefined, bob, alice]) {
        const res = await w.send({
          method,
          path: `space/${S}/collections`,
          ...(as ? { as, ...(as === alice ? { root: w.spaceUrl(S) } : {}) } : {}),
        });
        expect(res.status).toBe(405);
        expect(res.header('allow')).toBe('GET, HEAD, POST');
      }
    }

    expect(await w.store.transaction((tx) => tx.countSpaces())).toBe(1);
  });
});

describe('optional groups this server does not build', () => {
  const owner = (w: World) => ({ as: alice, root: w.spaceUrl(S) });

  it('tells the controller 501 for a method the group defines, and a stranger 404', async () => {
    const w = await world();
    const cases: Array<[string, string]> = [
      ['GET', `space/${S}/${C}/a/chunks/`],
      ['GET', `space/${S}/${C}/a/chunks/c1`],
      ['PUT', `space/${S}/${C}/a/chunks/c1`],
      ['DELETE', `space/${S}/${C}/a/chunks/c1`],
      ['GET', `space/${S}/${C}/meta/log`],
      ['PUT', `space/${S}/${C}/meta/log`],
      ['POST', `space/${S}/export`],
      ['POST', `space/${S}/import`],
      ['POST', `space/${S}/query`],
    ];
    for (const [method, path] of cases) {
      const mine = await w.send({ method, path, ...owner(w), ...(method === 'GET' ? {} : { json: {} }) });
      expect([method, path, mine.status]).toEqual([method, path, 501]);
      expect(mine.type).toBe('unsupported-operation');
      const theirs = await w.send({ method, path, as: bob, ...(method === 'GET' ? {} : { json: {} }) });
      expect([method, path, theirs.status]).toEqual([method, path, 404]);
    }
  });

  it('checks the shape of a query body once the caller is authorized: no profile is 400, any profile is 501', async () => {
    const w = await world();
    const path = `space/${S}/${C}/query`;
    for (const body of [{}, { limit: 10 }, { profile: 7 }, { profile: '' }, { profile: null }, [], 'x']) {
      const mine = await w.send({ method: 'POST', path, ...owner(w), json: body });
      expect([JSON.stringify(body), mine.status, mine.type]).toEqual([
        JSON.stringify(body),
        400,
        'invalid-request-body',
      ]);
      expect((await w.send({ method: 'POST', path, as: bob, json: body })).status).toBe(404);
    }

    for (const profile of ['changes', 'blinded-index', 'a-profile-nobody-has-registered']) {
      const mine = await w.send({ method: 'POST', path, ...owner(w), json: { profile, limit: 10 } });
      expect([profile, mine.status, mine.type]).toEqual([profile, 501, 'unsupported-operation']);
      expect((await w.send({ method: 'POST', path, as: bob, json: { profile } })).status).toBe(404);
    }

    // a body that is not JSON, or no Content-Type, is the same request error
    const text = await w.send({
      method: 'POST',
      path,
      ...owner(w),
      body: 'profile=changes',
      contentType: 'text/plain',
    });
    expect(text.status).toBe(400);
  });

  it('never lists a feature token for them', async () => {
    const w = await world();
    const features = (await w.send({ method: 'GET', path: 'service' })).json.specs['https://w3id.org/pws'][0]
      .features as string[];
    for (const token of [
      'backends',
      'quotas',
      'changes-query',
      'export',
      'import',
      'encrypted-collections',
    ]) {
      expect(features).not.toContain(token);
    }
  });
});
