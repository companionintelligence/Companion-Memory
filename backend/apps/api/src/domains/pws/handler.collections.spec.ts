import { ORIGIN, World, alice, app, bob } from './__tests__/testKit';

const S = 'space-1';

async function world(): Promise<World> {
  const w = new World();
  await w.createSpace(alice, S, { name: 'Alice' });
  return w;
}

describe('Create Collection: POST /space/{s}/', () => {
  it('creates a Collection: 201, absolute Location, ETag and the Metadata object', async () => {
    const w = await world();
    const res = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      json: { name: 'Verifiable Credentials Collection', type: ['Collection'] },
    });
    expect(res.status).toBe(201);
    expect(res.header('location')).toBe(`${ORIGIN}/space/${S}/gen-1/`);
    expect(res.json).toEqual({
      id: 'gen-1',
      url: `/space/${S}/gen-1/`,
      type: ['Collection'],
      name: 'Verifiable Credentials Collection',
      createdAt: '2026-11-05T12:00:00.000Z',
      updatedAt: '2026-11-05T12:00:00.000Z',
      createdBy: alice.did,
      linkset: `/space/${S}/gen-1/linkset`,
      backend: { id: 'default' },
      updatedAtCounter: expect.any(Number),
      originId: 'test-origin',
    });
  });

  it('needs authorization before it says anything about ids: a stranger gets 404, never id-conflict', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs');
    const stranger = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: bob,
      root: w.spaceUrl(S),
      json: { id: 'docs' },
    });
    expect(stranger.status).toBe(404);
    const owner = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      json: { id: 'docs' },
    });
    expect(owner.status).toBe(409);
    expect(owner.type).toBe('id-conflict');
  });

  it('is delegable: a Space grant that allows POST creates a Collection', async () => {
    const w = await world();
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.spaceUrl(S),
      actions: ['POST'],
    });
    const res = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: app,
      via: grant,
      json: { id: 'made-by-app' },
    });
    expect(res.status).toBe(201);
    expect(res.json.createdBy).toBe(app.did);
  });

  it('refuses a reserved id: 409 reserved-id', async () => {
    const w = await world();
    for (const id of [
      'meta',
      'policy',
      'backends',
      'collections',
      'export',
      'import',
      'linkset',
      'query',
      'quotas',
    ]) {
      const res = await w.send({
        method: 'POST',
        path: `space/${S}/`,
        as: alice,
        root: w.spaceUrl(S),
        json: { id },
      });
      expect(res.type).toBe('reserved-id');
    }
  });

  it('refuses an id that is not URL-safe, and a body that is not a JSON object', async () => {
    const w = await world();
    const bad = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      json: { id: 'a b' },
    });
    expect(bad.type).toBe('invalid-id');
    const notObject = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      json: [1],
    });
    expect(notObject.type).toBe('invalid-request-body');
    const emptyObject = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      body: '{}',
      contentType: 'application/json',
    });
    expect(emptyObject.status).toBe(201);
    const text = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      body: 'x',
      contentType: 'text/plain',
    });
    expect(text.type).toBe('invalid-request-body');
  });

  it('refuses a write whose body has no Content-Type: 400 missing-content-type', async () => {
    const w = await world();
    const res = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      unsignedBody: '{"id":"x"}',
    });
    expect(res.status).toBe(400);
    expect(res.type).toBe('missing-content-type');
  });

  it('refuses what this server does not implement: encryption (unsupported-encryption-scheme), another backend (unsupported-backend)', async () => {
    const w = await world();
    const enc = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      json: { id: 'secret', encryption: { scheme: 'edv', version: 1 } },
    });
    expect(enc.status).toBe(400);
    expect(enc.type).toBe('unsupported-encryption-scheme');
    const backend = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      json: { id: 'far', backend: { id: 's3' } },
    });
    expect(backend.status).toBe(409);
    expect(backend.type).toBe('unsupported-backend');
  });

  it('validates the generator member as an assertion by the controller', async () => {
    const w = await world();
    const post = (generator: unknown) =>
      w.send({ method: 'POST', path: `space/${S}/`, as: alice, root: w.spaceUrl(S), json: { generator } });
    const ok = await post({
      id: app.did,
      origin: 'https://app.example.com',
      url: 'https://app.example.com/notes/',
      name: 'Notes',
    });
    expect(ok.status).toBe(201);
    expect(ok.json.generator).toEqual({
      id: app.did,
      origin: 'https://app.example.com',
      url: 'https://app.example.com/notes/',
      name: 'Notes',
    });
    for (const bad of [
      'x',
      {},
      { id: 'not-a-did' },
      { id: app.did, extra: 1 },
      { id: app.did, url: 'https://app.example.com/' },
      { id: app.did, origin: 'https://app.example.com/path' },
      { id: app.did, origin: 'https://app.example.com', url: 'https://other.example.com/' },
      { id: app.did, origin: 'https://app.example.com', url: 'https://app.example.com/?q=1' },
      { id: app.did, name: '' },
    ]) {
      expect((await post(bad)).type).toBe('invalid-request-body');
    }
  });
});

describe('Collection Metadata: GET and PUT /space/{s}/{c}/meta', () => {
  const meta = `space/${S}/docs/meta`;

  it('reads with an ETag and answers 304 to a matching If-None-Match', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs');
    const res = await w.send({ method: 'GET', path: meta, as: alice, root: w.spaceUrl(S) });
    expect(res.status).toBe(200);
    expect(res.json.id).toBe('docs');
    const again = await w.send({
      method: 'GET',
      path: meta,
      as: alice,
      root: w.spaceUrl(S),
      headers: { 'if-none-match': res.header('etag') as string },
    });
    expect(again.status).toBe(304);
  });

  it('creates the Collection when none exists: 201, Location of the Collection, ETag, and the object', async () => {
    const w = await world();
    const put = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      root: w.spaceUrl(S),
      json: { id: 'docs', name: 'Docs', plaintext: { indexes: ['parentId'] } },
    });
    expect(put.status).toBe(201);
    expect(put.header('location')).toBe(`${ORIGIN}/space/${S}/docs/`);
    expect(put.header('etag')).toBeDefined();
    expect(put.json).toMatchObject({
      id: 'docs',
      url: `/space/${S}/docs/`,
      name: 'Docs',
      backend: { id: 'default' },
      plaintext: { indexes: ['parentId'] },
      createdBy: alice.did,
      originId: 'test-origin',
    });
    const read = await w.send({ method: 'GET', path: meta, as: alice, root: w.spaceUrl(S) });
    expect(read.json).toEqual(put.json);
    expect(read.header('etag')).toBe(put.header('etag'));
  });

  it('is a full replacement: omitted members are cleared, except backend, generator and plaintext', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs', {
      generator: { id: app.did },
      plaintext: { indexes: ['author'] },
      custom: { tags: { project: 'demo' } },
      epoch: 'e1',
    });
    const put = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      root: w.spaceUrl(S),
      json: { id: 'docs', name: 'Renamed' },
    });
    expect(put.status).toBe(204);
    const read = (await w.send({ method: 'GET', path: meta, as: alice, root: w.spaceUrl(S) })).json;
    expect(read.name).toBe('Renamed');
    expect(read.custom).toBeUndefined(); // cleared
    expect(read.epoch).toBeUndefined(); // cleared
    expect(read.backend).toEqual({ id: 'default' }); // kept
    expect(read.generator).toEqual({ id: app.did }); // kept
    expect(read.plaintext).toEqual({ indexes: ['author'] }); // kept
  });

  it('echoes plaintext.indexes as declared and lets {} empty it', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs', {
      plaintext: { indexes: ['author', { name: 'slug', unique: true }] },
    });
    const read = () => w.send({ method: 'GET', path: meta, as: alice, root: w.spaceUrl(S) });
    expect((await read()).json.plaintext).toEqual({ indexes: ['author', { name: 'slug', unique: true }] });
    await w.send({ method: 'PUT', path: meta, as: alice, root: w.spaceUrl(S), json: { plaintext: {} } });
    expect((await read()).json.plaintext).toEqual({});
  });

  it('rejects a malformed plaintext member, and plaintext together with encryption', async () => {
    const w = await world();
    const post = (plaintext: unknown, extra: Record<string, unknown> = {}) =>
      w.send({
        method: 'POST',
        path: `space/${S}/`,
        as: alice,
        root: w.spaceUrl(S),
        json: { plaintext, ...extra },
      });
    for (const bad of [
      'x',
      { indexes: 'name' },
      { indexes: [{}] },
      { indexes: [{ name: '' }] },
      { indexes: ['a', 'a'] },
      { indexes: ['tag', { name: 'tag', source: 'custom' }] },
      { indexes: [{ name: 'x', source: 'elsewhere' }] },
      { indexes: [{ name: 'x', unique: 'yes' }] },
      { other: 1 },
    ]) {
      expect((await post(bad)).type).toBe('invalid-request-body');
    }
    expect((await post({}, { encryption: { scheme: 'edv' } })).type).toBe('invalid-request-body');
  });

  it('refuses a unique claim it cannot enforce (source custom)', async () => {
    const w = await world();
    const res = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      json: { plaintext: { indexes: [{ name: 'tag', source: 'custom', unique: true }] } },
    });
    expect(res.status).toBe(501);
    expect(res.type).toBe('unsupported-operation');
  });

  it('creates at a client-chosen id with PUT: 201, Location, ETag; honours If-None-Match: *', async () => {
    const w = await world();
    const res = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      root: w.spaceUrl(S),
      headers: { 'if-none-match': '*' },
      json: { id: 'docs', name: 'Docs' },
    });
    expect(res.status).toBe(201);
    expect(res.header('location')).toBe(`${ORIGIN}/space/${S}/docs/`);
    const again = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      root: w.spaceUrl(S),
      headers: { 'if-none-match': '*' },
      json: { name: 'Docs' },
    });
    expect(again.status).toBe(412);
  });

  it('honours If-Match: a stale validator is 412, the current one writes', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs');
    const etag = (await w.send({ method: 'GET', path: meta, as: alice, root: w.spaceUrl(S) })).header(
      'etag',
    ) as string;
    const stale = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      root: w.spaceUrl(S),
      headers: { 'if-match': '"zzz.1"' },
      json: { name: 'x' },
    });
    expect(stale.type).toBe('precondition-failed');
    const ok = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      root: w.spaceUrl(S),
      headers: { 'if-match': etag },
      json: { name: 'x' },
    });
    expect(ok.status).toBe(204);
    expect(ok.header('etag')).not.toBe(etag);
  });

  it('writing a Resource does not move the Collection validator, and the reverse', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs');
    const before = (await w.send({ method: 'GET', path: meta, as: alice, root: w.spaceUrl(S) })).header(
      'etag',
    );
    await w.putResource(alice, S, 'docs', 'a', { n: 1 });
    const after = (await w.send({ method: 'GET', path: meta, as: alice, root: w.spaceUrl(S) })).header(
      'etag',
    );
    expect(after).toBe(before);
  });

  describe('the container rule', () => {
    it('lets a delegate write it through a grant on exactly the Space URL, or on exactly the Collection URL', async () => {
      const w = await world();
      await w.createCollection(alice, S, 'docs');
      for (const target of [w.spaceUrl(S), `${w.spaceUrl(S)}docs/`]) {
        const grant = await w.delegate({
          from: alice,
          to: app,
          spaceId: S,
          target,
          actions: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        });
        const res = await w.send({
          method: 'PUT',
          path: meta,
          as: app,
          via: grant,
          json: { id: 'docs', name: `by ${target}` },
        });
        expect(res.status).toBe(204);
        expect((await w.send({ method: 'GET', path: meta, as: alice, root: w.spaceUrl(S) })).json.name).toBe(
          `by ${target}`,
        );
      }
    });

    it('refuses a grant on the Metadata URL itself or on a Resource', async () => {
      const w = await world();
      await w.createCollection(alice, S, 'docs');
      for (const target of [`${w.spaceUrl(S)}docs/meta`, `${w.spaceUrl(S)}docs/some-resource`]) {
        const grant = await w.delegate({ from: alice, to: app, spaceId: S, target, actions: ['PUT'] });
        const res = await w.send({ method: 'PUT', path: meta, as: app, via: grant, json: { name: 'x' } });
        // A grant for a narrower target does not even cover the request; either way, 404.
        expect(res.status).toBe(404);
      }
    });

    it('never lets a delegate delete a Collection, whatever the grant', async () => {
      const w = await world();
      await w.createCollection(alice, S, 'docs');
      for (const target of [w.spaceUrl(S), `${w.spaceUrl(S)}docs/`]) {
        const grant = await w.delegate({ from: alice, to: app, spaceId: S, target, actions: ['DELETE'] });
        const res = await w.send({ method: 'DELETE', path: `space/${S}/docs/`, as: app, via: grant });
        expect(res.status).toBe(404);
      }
      expect((await w.send({ method: 'GET', path: meta, as: alice, root: w.spaceUrl(S) })).status).toBe(200);
    });
  });
});

describe('List Collections: GET /space/{s}/', () => {
  it('lists with id, url, name (defaulting to the id) and an explicit public flag', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs', { name: 'Documents' });
    await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      json: { id: 'nameless' },
    });
    await w.send({
      method: 'PUT',
      path: `space/${S}/nameless/policy`,
      as: alice,
      root: w.spaceUrl(S),
      json: { type: 'PublicCanRead' },
    });
    const res = await w.send({ method: 'GET', path: `space/${S}/`, as: alice, root: w.spaceUrl(S) });
    expect(res.json).toEqual({
      url: `/space/${S}/`,
      totalItems: 2,
      items: [
        { id: 'docs', url: `/space/${S}/docs/`, name: 'Documents', public: false },
        { id: 'nameless', url: `/space/${S}/nameless/`, name: 'nameless', public: true },
      ],
    });
  });

  it('shows a delegate scoped to one Collection nothing of the Space', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs');
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: `${w.spaceUrl(S)}docs/`,
      actions: ['GET'],
    });
    expect((await w.send({ method: 'GET', path: `space/${S}/`, as: app, via: grant })).status).toBe(404);
    expect((await w.send({ method: 'GET', path: `space/${S}/docs/`, as: app, via: grant })).status).toBe(200);
  });
});

describe('Delete Collection: DELETE /space/{s}/{c}/', () => {
  it('removes the Collection and its Resources, and is idempotent for the controller', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs');
    await w.putResource(alice, S, 'docs', 'a', { n: 1 });
    const del = () => w.send({ method: 'DELETE', path: `space/${S}/docs/`, as: alice, root: w.spaceUrl(S) });
    expect((await del()).status).toBe(204);
    expect(await w.store.transaction((tx) => tx.getResource(S, 'docs', 'a'))).toBeUndefined();
    expect((await del()).status).toBe(204);
  });

  it('honours If-Match and If-None-Match: a stale validator is 412 and deletes nothing', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs');
    await w.putResource(alice, S, 'docs', 'a', { n: 1 });
    const send = (headers: Record<string, string>, id = 'docs') =>
      w.send({ method: 'DELETE', path: `space/${S}/${id}/`, as: alice, root: w.spaceUrl(S), headers });
    expect((await send({ 'if-match': '"stale.9"' })).status).toBe(412);
    expect((await send({ 'if-none-match': '*' })).status).toBe(412); // it exists
    expect((await send({ 'if-match': '"any.1"' }, 'nothing-here')).status).toBe(412); // it does not
    expect(await w.store.transaction((tx) => tx.getResource(S, 'docs', 'a'))).toBeDefined();
    const etag = (
      await w.send({ method: 'GET', path: `space/${S}/docs/meta`, as: alice, root: w.spaceUrl(S) })
    ).header('etag') as string;
    expect((await send({ 'if-match': etag })).status).toBe(204);
    expect(await w.store.transaction((tx) => tx.getCollection(S, 'docs'))).toBeUndefined();
  });

  it('is 404 for a stranger and leaves the Collection alone', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs');
    expect((await w.send({ method: 'DELETE', path: `space/${S}/docs/`, as: bob })).status).toBe(404);
    expect(await w.store.transaction((tx) => tx.getCollection(S, 'docs'))).toBeDefined();
  });
});

describe('List Resources: GET /space/{s}/{c}/', () => {
  async function filled(): Promise<World> {
    const w = await world();
    await w.createCollection(alice, S, 'docs', { name: 'Docs' });
    for (const id of ['a', 'b', 'c']) {
      await w.putResource(alice, S, 'docs', id, { id });
    }
    return w;
  }

  it('lists with the Collection envelope', async () => {
    const w = await filled();
    const res = await w.send({ method: 'GET', path: `space/${S}/docs/`, as: alice, root: w.spaceUrl(S) });
    expect(res.json).toEqual({
      id: 'docs',
      url: `/space/${S}/docs/`,
      name: 'Docs',
      type: ['Collection'],
      totalItems: 3,
      items: ['a', 'b', 'c'].map((id) => ({
        id,
        url: `/space/${S}/docs/${id}`,
        contentType: 'application/json',
      })),
    });
  });

  it('pages with limit and next, clamps an oversized limit, and rejects a bad one', async () => {
    const w = await filled();
    const first = await w.send({
      method: 'GET',
      path: `space/${S}/docs/?limit=2`,
      as: alice,
      root: w.spaceUrl(S),
    });
    expect(first.json.items.map((i: { id: string }) => i.id)).toEqual(['a', 'b']);
    const second = await w.send({
      method: 'GET',
      path: (first.json.next as string).slice(1),
      as: alice,
      root: w.spaceUrl(S),
    });
    expect(second.json.items.map((i: { id: string }) => i.id)).toEqual(['c']);
    expect(second.json.next).toBeUndefined();
    expect(
      (await w.send({ method: 'GET', path: `space/${S}/docs/?limit=99999`, as: alice, root: w.spaceUrl(S) }))
        .status,
    ).toBe(200);
    for (const limit of ['0', '-1', 'x', '1.5']) {
      expect(
        (
          await w.send({
            method: 'GET',
            path: `space/${S}/docs/?limit=${limit}`,
            as: alice,
            root: w.spaceUrl(S),
          })
        ).status,
      ).toBe(400);
    }
  });

  it('refuses a cursor carried over from another list, and a malformed one — to an authorized caller only', async () => {
    const w = await filled();
    await w.createCollection(alice, S, 'other');
    const cursor = (
      (await w.send({ method: 'GET', path: `space/${S}/docs/?limit=1`, as: alice, root: w.spaceUrl(S) })).json
        .next as string
    ).split('cursor=')[1];
    const foreign = await w.send({
      method: 'GET',
      path: `space/${S}/other/?cursor=${cursor}`,
      as: alice,
      root: w.spaceUrl(S),
    });
    expect(foreign.type).toBe('invalid-cursor');
    const garbage = await w.send({
      method: 'GET',
      path: `space/${S}/docs/?cursor=!!`,
      as: alice,
      root: w.spaceUrl(S),
    });
    expect(garbage.type).toBe('invalid-cursor');
    // A stranger must not learn that the list exists by getting a 400.
    const stranger = await w.send({ method: 'GET', path: `space/${S}/docs/?cursor=!!`, as: bob });
    expect(stranger.status).toBe(404);
  });

  it('lets one capability read every page: the query never changes the target', async () => {
    const w = await filled();
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: `${w.spaceUrl(S)}docs/`,
      actions: ['GET'],
    });
    const first = await w.send({ method: 'GET', path: `space/${S}/docs/?limit=1`, as: app, via: grant });
    expect(first.status).toBe(200);
    const next = await w.send({
      method: 'GET',
      path: (first.json.next as string).slice(1),
      as: app,
      via: grant,
    });
    expect(next.status).toBe(200);
  });
});

describe('hardening found by review', () => {
  it('refuses deeply nested custom.tags with 400 instead of failing inside the store', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs');
    // built as text: 20,000 levels is about 120 kB, far under the 1 MiB body cap, and too deep to stringify
    const nested = `${'{"n":'.repeat(20000)}"leaf"${'}'.repeat(20000)}`;
    const meta = `space/${S}/docs/meta`;
    const put = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      root: w.spaceUrl(S),
      body: `{"custom":{"tags":${nested}}}`,
      contentType: 'application/json',
    });
    expect([put.status, put.type]).toEqual([400, 'invalid-request-body']);
    const shallow = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      root: w.spaceUrl(S),
      json: { custom: { tags: { a: { b: { c: 'ok' } } } } },
    });
    expect(shallow.status).toBe(204);
  });

  it('holds a body epoch to the rule of the Key-Epoch header', async () => {
    const w = await world();
    for (const epoch of ['', 'x'.repeat(129), 'has space']) {
      const res = await w.send({
        method: 'POST',
        path: `space/${S}/`,
        as: alice,
        root: w.spaceUrl(S),
        json: { id: 'e', epoch },
      });
      expect([JSON.stringify(epoch).slice(0, 12), res.status]).toEqual([
        JSON.stringify(epoch).slice(0, 12),
        400,
      ]);
    }
    const ok = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      json: { id: 'e', epoch: 'e-2026.1' },
    });
    expect(ok.status).toBe(201);
  });

  it('refuses an index named __proto__, and reads only own properties for the others', async () => {
    const w = await world();
    const res = await w.send({
      method: 'POST',
      path: `space/${S}/`,
      as: alice,
      root: w.spaceUrl(S),
      json: { id: 'p', plaintext: { indexes: [{ name: '__proto__', unique: true }] } },
    });
    expect([res.status, res.type]).toEqual([400, 'invalid-request-body']);
    await w.createCollection(alice, S, 'u', {
      plaintext: { indexes: [{ name: 'constructor', unique: true }] },
    });
    for (const id of ['one', 'two']) {
      const put = await w.putResource(alice, S, 'u', id, { other: id });
      expect([id, put.status]).toEqual([id, 204]);
    }
  });

  it('refuses a generator url that is not a string, or that has an empty query or fragment', async () => {
    const w = await world();
    for (const url of [
      ['https://app.example.com/x'],
      'https://app.example.com/x?',
      'https://app.example.com/x#',
    ]) {
      const res = await w.send({
        method: 'POST',
        path: `space/${S}/`,
        as: alice,
        root: w.spaceUrl(S),
        json: { id: 'g', generator: { id: app.did, origin: 'https://app.example.com', url } },
      });
      expect([JSON.stringify(url), res.status]).toEqual([JSON.stringify(url), 400]);
    }
  });

  it('answers 400 invalid-request-body, not unsupported-encryption-scheme, when encryption would join a stored plaintext', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'docs', { plaintext: {} });
    const res = await w.send({
      method: 'PUT',
      path: `space/${S}/docs/meta`,
      as: alice,
      root: w.spaceUrl(S),
      json: { encryption: { scheme: 'edv' } },
    });
    expect([res.status, res.type]).toEqual([400, 'invalid-request-body']);
  });
});
