import { ORIGIN, World, alice, app, bob, carol } from './__tests__/testKit';
import { rootZcapId } from './zcap';

const SPACE = '81246131-69a4-45ab-9bff-9c946b59cf2e';

describe('Create Space: POST /spaces/', () => {
  it('needs a capability invocation: no credential is 401 missing-authorization', async () => {
    const w = new World();
    const res = await w.send({ method: 'POST', path: 'spaces/', json: { controller: alice.did } });
    expect(res.status).toBe(401);
    expect(res.type).toBe('missing-authorization');
  });

  it('creates a Space its signer controls: 201, absolute Location, ETag, and exactly the Metadata members', async () => {
    const w = new World();
    const res = await w.send({
      method: 'POST',
      path: 'spaces/',
      as: alice,
      json: { type: ['Space'], name: 'Example space #1', controller: alice.did },
    });
    expect(res.status).toBe(201);
    expect(res.header('location')).toBe(`${ORIGIN}/space/gen-1/`);
    expect(res.header('etag')).toMatch(/^"[a-z0-9]+\.1"$/);
    expect(res.header('content-type')).toBe('application/json');
    expect(res.json).toEqual({
      id: 'gen-1',
      url: '/space/gen-1/',
      type: ['Space'],
      name: 'Example space #1',
      controller: alice.did,
      createdBy: alice.did,
      linkset: '/space/gen-1/linkset',
      updatedAt: '2026-11-05T12:00:00.000Z',
      updatedAtCounter: 0,
      originId: 'test-origin',
    });
  });

  it('uses the id the client chooses', async () => {
    const w = new World();
    const res = await w.send({
      method: 'POST',
      path: 'spaces/',
      as: alice,
      json: { id: SPACE, controller: alice.did },
    });
    expect(res.status).toBe(201);
    expect(res.json.id).toBe(SPACE);
  });

  it('refuses a body with no controller: 400 invalid-request-body', async () => {
    const w = new World();
    const res = await w.send({ method: 'POST', path: 'spaces/', as: alice, json: { name: 'orphan' } });
    expect(res.status).toBe(400);
    expect(res.type).toBe('invalid-request-body');
  });

  it('refuses a non-URL-safe id: 400 invalid-id', async () => {
    const w = new World();
    for (const id of ['has space', 'a/b', '..', '.', 'x'.repeat(129), 'café']) {
      const res = await w.send({
        method: 'POST',
        path: 'spaces/',
        as: alice,
        json: { id, controller: alice.did },
      });
      expect(res.type).toBe('invalid-id');
    }
  });

  it('refuses a request signed by someone other than the controller in the body: 400 controller-mismatch', async () => {
    const w = new World();
    const res = await w.send({ method: 'POST', path: 'spaces/', as: bob, json: { controller: alice.did } });
    expect(res.status).toBe(400);
    expect(res.type).toBe('controller-mismatch');
  });

  describe('which DIDs may control a Space', () => {
    it('refuses a controller that is not a DID', async () => {
      const w = new World();
      for (const controller of ['alice', 'https://example.com/alice', 42, null]) {
        const res = await w.send({ method: 'POST', path: 'spaces/', as: alice, json: { controller } });
        expect(res.status).toBe(400);
        expect(res.type).toBe('invalid-request-body');
      }
    });

    it('refuses a DID method it does not support, and says which it does', async () => {
      const w = new World();
      const res = await w.send({
        method: 'POST',
        path: 'spaces/',
        as: alice,
        json: { controller: 'did:web:example.com' },
      });
      expect(res.status).toBe(400);
      expect(res.type).toBe('invalid-request-body');
      expect(res.json.detail).toContain('did:key');
    });

    it('refuses did:keri, including the exact spelling Companion Memory uses for its peers', async () => {
      const w = new World();
      const spellings = [
        `did:keri:E${'A'.repeat(43)}`, // a KERI AID (made up, 44 characters like a real one)
        'did:keri:DAbcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', // `did:keri:D<jwk-x>`, the peers/sovereignKeyId convention
      ];
      for (const controller of spellings) {
        const res = await w.send({ method: 'POST', path: 'spaces/', as: alice, json: { controller } });
        expect(res.status).toBe(400);
        expect(res.type).toBe('invalid-request-body');
        expect(res.json.detail).toMatch(/not supported as a Space controller/);
      }
      expect(await w.store.transaction((tx) => tx.countSpaces())).toBe(0);
    });

    it('refuses a did:key that is not an Ed25519 Multikey', async () => {
      const w = new World();
      // a P-256 did:key (multicodec 0x1200)
      const res = await w.send({
        method: 'POST',
        path: 'spaces/',
        as: alice,
        json: { controller: 'did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169' },
      });
      expect(res.status).toBe(400);
      expect(res.type).toBe('invalid-request-body');
    });
  });

  describe('an id that is taken', () => {
    it('is 409 id-conflict, and the loser cannot overwrite or take over the Space', async () => {
      const w = new World();
      await w.createSpace(alice, SPACE, { name: 'Alice' });
      // Bob has a perfectly valid invocation for his *own* controller. If POST were create-or-replace,
      // this would hand him Alice's Space.
      const res = await w.send({
        method: 'POST',
        path: 'spaces/',
        as: bob,
        json: { id: SPACE, controller: bob.did, name: 'Mine now' },
      });
      expect(res.status).toBe(409);
      expect(res.type).toBe('id-conflict');
      const read = await w.send({
        method: 'GET',
        path: `space/${SPACE}/meta`,
        as: alice,
        root: w.spaceUrl(SPACE),
      });
      expect(read.json.controller).toBe(alice.did);
      expect(read.json.name).toBe('Alice');
    });
  });

  it('ignores createdBy, url, linkset and backends in a body', async () => {
    const w = new World();
    const res = await w.send({
      method: 'POST',
      path: 'spaces/',
      as: alice,
      json: { controller: alice.did, createdBy: bob.did, url: '/x', linkset: '/y', backends: [{ id: 'z' }] },
    });
    expect(res.status).toBe(201);
    expect(res.json.createdBy).toBe(alice.did);
    expect(res.json.url).toBe('/space/gen-1/');
    expect(res.json).not.toHaveProperty('backends');
  });

  describe('delegated provisioning', () => {
    const spacesUrl = `${ORIGIN}/spaces/`;

    it('lets an app create a Space on behalf of its eventual controller', async () => {
      const w = new World();
      const grant = await w.delegate({
        from: alice,
        to: app,
        rootTarget: spacesUrl,
        target: spacesUrl,
        actions: ['POST'],
      });
      const res = await w.send({
        method: 'POST',
        path: 'spaces/',
        as: app,
        via: grant,
        json: { id: SPACE, controller: alice.did },
      });
      expect(res.status).toBe(201);
      expect(res.json.controller).toBe(alice.did);
      // The creator is the party that invoked, which is not the controller.
      expect(res.json.createdBy).toBe(app.did);
    });

    it('answers every failed chain with controller-mismatch, and tells the three causes apart', async () => {
      const w = new World();
      const details = new Set<string>();

      // 1. rooted in another DID: bob signed the delegation, but the body names alice.
      const foreign = await w.delegate({
        from: bob,
        to: app,
        rootTarget: spacesUrl,
        target: spacesUrl,
        actions: ['POST'],
      });
      // 2. expired
      const stale = await w.delegate({
        from: alice,
        to: app,
        rootTarget: spacesUrl,
        target: spacesUrl,
        actions: ['POST'],
        expiresInSeconds: 60,
      });
      // 3. a proof that does not verify: the signed document was altered afterwards
      const good = await w.delegate({
        from: alice,
        to: app,
        rootTarget: spacesUrl,
        target: spacesUrl,
        actions: ['POST'],
      });
      const forged = { ...good, controller: carol.did };

      w.advance(2000);
      for (const [grant, as] of [
        [foreign, app],
        [stale, app],
        [forged, carol],
      ] as const) {
        const res = await w.send({
          method: 'POST',
          path: 'spaces/',
          as,
          via: grant,
          json: { controller: alice.did },
        });
        expect(res.status).toBe(400);
        expect(res.type).toBe('controller-mismatch');
        details.add(res.json.detail);
      }
      expect(details.size).toBe(3);
    });
  });
});

describe('List Spaces: GET /spaces/', () => {
  it('is an empty list, not an error, with no credential', async () => {
    const w = new World();
    await w.createSpace(alice, SPACE);
    const res = await w.send({ method: 'GET', path: 'spaces/' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ url: '/spaces/', totalItems: 0, items: [] });
  });

  it('lists only the Spaces the invoker controls', async () => {
    const w = new World();
    await w.createSpace(alice, 'a-1');
    await w.createSpace(alice, 'a-2');
    await w.createSpace(bob, 'b-1');
    const res = await w.send({ method: 'GET', path: 'spaces/', as: alice });
    expect(res.json.totalItems).toBe(2);
    expect(res.json.items).toEqual([
      { id: 'a-1', url: '/space/a-1/', type: ['Space'], name: 'a-1' },
      { id: 'a-2', url: '/space/a-2/', type: ['Space'], name: 'a-2' },
    ]);
    expect((await w.send({ method: 'GET', path: 'spaces/', as: carol })).json.items).toEqual([]);
  });

  it('pages by cursor and refuses a cursor from another list', async () => {
    const w = new World();
    for (const id of ['s-1', 's-2', 's-3']) {
      await w.createSpace(alice, id);
    }
    const first = await w.send({ method: 'GET', path: 'spaces/?limit=2', as: alice });
    expect(first.json.items.map((i: { id: string }) => i.id)).toEqual(['s-1', 's-2']);
    const next = first.json.next as string;
    expect(next).toMatch(/^\/spaces\/\?limit=2&cursor=/);
    const second = await w.send({ method: 'GET', path: next.slice(1), as: alice });
    expect(second.json.items.map((i: { id: string }) => i.id)).toEqual(['s-3']);
    expect(second.json.next).toBeUndefined();
    const bad = await w.send({ method: 'GET', path: 'spaces/?cursor=not-a-cursor', as: alice });
    expect(bad.status).toBe(400);
    expect(bad.type).toBe('invalid-cursor');
  });
});

describe('Space Metadata: GET and PUT /space/{s}/meta', () => {
  async function world(): Promise<World> {
    const w = new World();
    await w.createSpace(alice, SPACE, { name: 'Example space #1' });
    return w;
  }
  const meta = `space/${SPACE}/meta`;

  it('is readable by the controller, with an ETag, and 304 when unchanged', async () => {
    const w = await world();
    const res = await w.send({ method: 'GET', path: meta, as: alice, root: w.spaceUrl(SPACE) });
    expect(res.status).toBe(200);
    expect(res.json.controller).toBe(alice.did);
    const etag = res.header('etag') as string;
    const again = await w.send({
      method: 'GET',
      path: meta,
      as: alice,
      root: w.spaceUrl(SPACE),
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
  });

  it('answers a stranger exactly as it answers a Space that does not exist', async () => {
    const w = await world();
    const stranger = await w.send({ method: 'GET', path: meta, as: bob });
    const absent = await w.send({ method: 'GET', path: 'space/does-not-exist/meta', as: bob });
    const anonymous = await w.send({ method: 'GET', path: meta });
    for (const res of [stranger, absent, anonymous]) {
      expect(res.status).toBe(404);
      expect(res.type).toBe('not-found');
    }
    expect(stranger.text).toBe(absent.text);
    expect(stranger.text).toBe(anonymous.text);
  });

  it('is replaced by the controller: the name changes, an omitted name is cleared, the ETag moves', async () => {
    const w = await world();
    const before = (await w.send({ method: 'GET', path: meta, as: alice })).header('etag');
    const put = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      json: { id: SPACE, type: ['Space'], name: 'Renamed', controller: alice.did },
    });
    expect(put.status).toBe(204);
    expect(put.header('etag')).not.toBe(before);
    expect((await w.send({ method: 'GET', path: meta, as: alice })).json.name).toBe('Renamed');
    await w.send({ method: 'PUT', path: meta, as: alice, json: { controller: alice.did } });
    expect((await w.send({ method: 'GET', path: meta, as: alice })).json).not.toHaveProperty('name');
  });

  it('honours If-Match and If-None-Match: * atomically with the write', async () => {
    const w = await world();
    const etag = (await w.send({ method: 'GET', path: meta, as: alice })).header('etag') as string;
    const stale = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      headers: { 'if-match': '"nope.9"' },
      json: { controller: alice.did, name: 'x' },
    });
    expect(stale.status).toBe(412);
    expect(stale.type).toBe('precondition-failed');
    const exists = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      headers: { 'if-none-match': '*' },
      json: { controller: alice.did },
    });
    expect(exists.status).toBe(412);
    const ok = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      headers: { 'if-match': etag },
      json: { controller: alice.did, name: 'y' },
    });
    expect(ok.status).toBe(204);
  });

  it('refuses a body id that is not the URL id', async () => {
    const w = await world();
    const res = await w.send({
      method: 'PUT',
      path: meta,
      as: alice,
      json: { id: 'other', controller: alice.did },
    });
    expect(res.status).toBe(400);
    expect(res.type).toBe('invalid-request-body');
  });

  it('creates a Space at a client-chosen id, 201 with Location', async () => {
    const w = new World();
    const res = await w.send({
      method: 'PUT',
      path: `space/${SPACE}/meta`,
      as: alice,
      json: { name: 'Fresh', controller: alice.did },
    });
    expect(res.status).toBe(201);
    expect(res.header('location')).toBe(`${ORIGIN}/space/${SPACE}/`);
    expect(res.header('etag')).toBeDefined();
    // the body is the object that was created, as a POST would have answered
    expect(res.json).toMatchObject({
      id: SPACE,
      url: `/space/${SPACE}/`,
      name: 'Fresh',
      controller: alice.did,
      createdBy: alice.did,
      originId: 'test-origin',
    });
  });

  it('refuses to create-by-PUT for someone who is not the body controller (400), and for an anonymous caller (401)', async () => {
    const w = new World();
    const bobForAlice = await w.send({
      method: 'PUT',
      path: `space/${SPACE}/meta`,
      as: bob,
      json: { controller: alice.did },
    });
    expect(bobForAlice.status).toBe(400);
    expect(bobForAlice.type).toBe('controller-mismatch');
    const anonymous = await w.send({
      method: 'PUT',
      path: `space/${SPACE}/meta`,
      json: { controller: alice.did },
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.type).toBe('missing-authorization');
  });

  it('is never delegable, whatever the grant says (the container rule)', async () => {
    const w = await world();
    for (const actions of [['PUT'], ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'], undefined]) {
      const grant = await w.delegate({
        from: alice,
        to: app,
        spaceId: SPACE,
        target: w.spaceUrl(SPACE),
        ...(actions ? { actions } : {}),
      });
      const res = await w.send({
        method: 'PUT',
        path: meta,
        as: app,
        via: grant,
        json: { controller: app.did, name: 'Seized' },
      });
      expect(res.status).toBe(404);
    }
    const read = (await w.send({ method: 'GET', path: meta, as: alice })).json;
    expect(read.controller).toBe(alice.did);
    expect(read.name).toBe('Example space #1');
  });

  it('cannot be taken over by the would-be new controller', async () => {
    const w = await world();
    const res = await w.send({ method: 'PUT', path: meta, as: bob, json: { controller: bob.did } });
    expect(res.status).toBe(404);
    expect((await w.send({ method: 'GET', path: meta, as: alice })).json.controller).toBe(alice.did);
  });

  it('transfers control when the controller writes a new one; the old controller is then a stranger', async () => {
    const w = await world();
    const res = await w.send({ method: 'PUT', path: meta, as: alice, json: { controller: bob.did } });
    expect(res.status).toBe(204);
    expect((await w.send({ method: 'GET', path: meta, as: bob })).status).toBe(200);
    expect((await w.send({ method: 'GET', path: meta, as: alice })).status).toBe(404);
  });

  it('refuses to hand a Space to a controller of an unsupported method, and leaves it as it was', async () => {
    const w = await world();
    for (const controller of [`did:keri:E${'A'.repeat(43)}`, 'did:web:example.com']) {
      const res = await w.send({ method: 'PUT', path: meta, as: alice, json: { controller } });
      expect(res.status).toBe(400);
      expect(res.type).toBe('invalid-request-body');
    }
    expect((await w.send({ method: 'GET', path: meta, as: alice })).json.controller).toBe(alice.did);
  });

  it('accepts an anonymous read when a PublicCanRead policy is on the Space, and still refuses a write', async () => {
    const w = await world();
    await w.send({
      method: 'PUT',
      path: `space/${SPACE}/policy`,
      as: alice,
      root: w.spaceUrl(SPACE),
      json: { type: 'PublicCanRead' },
    });
    expect((await w.send({ method: 'GET', path: meta })).status).toBe(200);
    const write = await w.send({ method: 'PUT', path: meta, json: { controller: bob.did } });
    expect(write.status).toBe(401);
    expect(write.type).toBe('missing-authorization');
  });
});

describe('Delete Space: DELETE /space/{s}/', () => {
  async function world(): Promise<World> {
    const w = new World();
    await w.createSpace(alice, SPACE);
    await w.createCollection(alice, SPACE, 'docs');
    await w.putResource(alice, SPACE, 'docs', 'a', { n: 1 });
    return w;
  }
  const url = `space/${SPACE}/`;

  it('is controller-only for strangers: 404, nothing deleted', async () => {
    const w = await world();
    expect((await w.send({ method: 'DELETE', path: url, as: bob })).status).toBe(404);
    // anonymous: asked to authenticate, whatever is stored (the answer must not depend on it)
    expect((await w.send({ method: 'DELETE', path: url })).status).toBe(401);
    expect(await w.store.transaction((tx) => tx.countSpaces())).toBe(1);
  });

  it('honours If-Match and If-None-Match: a stale validator is 412 and deletes nothing', async () => {
    const w = await world();
    const send = (headers: Record<string, string>) =>
      w.send({ method: 'DELETE', path: url, as: alice, headers });
    expect((await send({ 'if-match': '"stale.9"' })).status).toBe(412);
    expect((await send({ 'if-none-match': '*' })).status).toBe(412); // it exists
    expect(await w.store.transaction((tx) => tx.countSpaces())).toBe(1);
    const etag = (await w.send({ method: 'GET', path: `space/${SPACE}/meta`, as: alice })).header(
      'etag',
    ) as string;
    expect((await send({ 'if-match': etag })).status).toBe(204);
    expect(await w.store.transaction((tx) => tx.countSpaces())).toBe(0);
  });

  it('removes the Space, its Collections and its Resources', async () => {
    const w = await world();
    const res = await w.send({ method: 'DELETE', path: url, as: alice });
    expect(res.status).toBe(204);
    await w.store.transaction(async (tx) => {
      expect(await tx.getSpace(SPACE)).toBeUndefined();
      expect(await tx.countCollections(SPACE)).toBe(0);
      expect(await tx.getResource(SPACE, 'docs', 'a')).toBeUndefined();
    });
  });

  it('accepts a delegated capability only if it targets exactly the Space URL and allows exactly DELETE', async () => {
    const w = await world();
    const target = w.spaceUrl(SPACE);

    for (const actions of [['GET', 'DELETE'], ['DELETE', 'POST'], undefined]) {
      const grant = await w.delegate({
        from: alice,
        to: app,
        spaceId: SPACE,
        target,
        ...(actions ? { actions } : {}),
      });
      expect((await w.send({ method: 'DELETE', path: url, as: app, via: grant })).status).toBe(404);
    }
    const deeper = await w.delegate({
      from: alice,
      to: app,
      spaceId: SPACE,
      target: `${target}docs/`,
      actions: ['DELETE'],
    });
    expect((await w.send({ method: 'DELETE', path: url, as: app, via: deeper })).status).toBe(404);
    expect(await w.store.transaction((tx) => tx.countSpaces())).toBe(1);

    const exact = await w.delegate({ from: alice, to: app, spaceId: SPACE, target, actions: ['DELETE'] });
    expect((await w.send({ method: 'DELETE', path: url, as: app, via: exact })).status).toBe(204);
    expect(await w.store.transaction((tx) => tx.countSpaces())).toBe(0);
  });

  it('answers an absent Space 404, because there is no controller to authorize against', async () => {
    const w = new World();
    expect((await w.send({ method: 'DELETE', path: 'space/none/', as: alice })).status).toBe(404);
  });
});

describe('rootZcapId', () => {
  it('names the Space root the way the specification does', () => {
    expect(rootZcapId(`${ORIGIN}/space/${SPACE}/`)).toBe(
      `urn:zcap:root:https%3A%2F%2Fexample.com%2Fspace%2F${SPACE}%2F`,
    );
  });
});
