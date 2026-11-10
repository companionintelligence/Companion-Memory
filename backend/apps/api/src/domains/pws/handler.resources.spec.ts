import { ORIGIN, World, alice, app, bob } from './__tests__/testKit';

const S = 'space-1';
const C = 'messages';

async function world(): Promise<World> {
  const w = new World();
  await w.createSpace(alice, S);
  await w.createCollection(alice, S, C);

  return w;
}

const as = (w: World) => ({ as: alice, root: w.spaceUrl(S) });
const r = (id: string) => `space/${S}/${C}/${id}`;

describe('Resources: the representation', () => {
  it('stores JSON and returns the very text that was sent', async () => {
    const w = await world();
    const text = '{ "message" :  "hi" }';
    expect(
      (
        await w.send({
          method: 'PUT',
          path: r('hello-world'),
          ...as(w),
          body: text,
          contentType: 'application/json',
        })
      ).status,
    ).toBe(204);
    const res = await w.send({ method: 'GET', path: r('hello-world'), ...as(w) });
    expect(res.status).toBe(200);
    expect(res.header('content-type')).toBe('application/json');
    expect(res.text).toBe(text);
    expect(res.header('etag')).toMatch(/^"[a-z0-9]+\.1"$/);
  });

  it('stores any other content type as opaque bytes, verbatim', async () => {
    const w = await world();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x0d, 0x0a]);
    await w.send({ method: 'PUT', path: r('sunset.png'), ...as(w), body: png, contentType: 'image/png' });
    const res = await w.send({ method: 'GET', path: r('sunset.png'), ...as(w) });
    expect(res.header('content-type')).toBe('image/png');
    expect([...(res.raw.body ?? [])]).toEqual([...png]);
    expect(res.header('content-length')).toBe(String(png.length));
  });

  it('answers HEAD with the headers of a GET and no body', async () => {
    const w = await world();
    await w.send({
      method: 'PUT',
      path: r('x.bin'),
      ...as(w),
      body: new Uint8Array(1234),
      contentType: 'application/octet-stream',
    });
    const head = await w.send({ method: 'HEAD', path: r('x.bin'), ...as(w) });
    expect(head.status).toBe(200);
    expect(head.header('content-type')).toBe('application/octet-stream');
    expect(head.header('content-length')).toBe('1234');
    expect(head.raw.body).toBeUndefined();
  });

  it('refuses a JSON content type with a body that is not JSON', async () => {
    const w = await world();
    const res = await w.send({
      method: 'PUT',
      path: r('bad'),
      ...as(w),
      body: '{nope',
      contentType: 'application/json',
    });
    expect(res.status).toBe(400);
    expect(res.type).toBe('invalid-request-body');
    expect(
      (
        await w.send({
          method: 'PUT',
          path: r('ld'),
          ...as(w),
          body: '{"a":1}',
          contentType: 'application/ld+json',
        })
      ).status,
    ).toBe(204);
  });

  it('refuses a body with no Content-Type (missing-content-type) and one over the limit (payload-too-large)', async () => {
    const w = new World({ maxUploadBytes: 16 });
    await w.createSpace(alice, S);
    await w.createCollection(alice, S, C);
    const none = await w.send({ method: 'PUT', path: r('a'), ...as(w), unsignedBody: 'x' });
    expect(none.type).toBe('missing-content-type');
    const big = await w.send({
      method: 'PUT',
      path: r('b'),
      ...as(w),
      body: new Uint8Array(17),
      contentType: 'application/octet-stream',
    });
    expect(big.status).toBe(413);
    expect(big.type).toBe('payload-too-large');
  });

  it('refuses a multipart/form-data upload (501) rather than store the envelope, but stores other multipart types verbatim', async () => {
    const w = await world();
    const body =
      '--b\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhi\r\n--b--\r\n';
    for (const method of ['PUT', 'POST']) {
      const path = method === 'PUT' ? r('form') : `space/${S}/${C}/`;
      const res = await w.send({
        method,
        path,
        ...as(w),
        body,
        contentType: 'multipart/form-data; boundary=b',
      });
      expect(res.status).toBe(501);
      expect(res.type).toBe('unsupported-operation');
    }

    expect((await w.send({ method: 'GET', path: r('form'), ...as(w) })).status).toBe(404);
    const mixed = await w.send({
      method: 'PUT',
      path: r('mixed'),
      ...as(w),
      body,
      contentType: 'multipart/mixed; boundary=b',
    });
    expect(mixed.status).toBe(204);
    expect((await w.send({ method: 'GET', path: r('mixed'), ...as(w) })).text).toBe(body);
  });

  it('replaces the whole representation, including its content type, on every write', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { v: 1 });
    await w.send({ method: 'PUT', path: r('doc'), ...as(w), body: 'plain', contentType: 'text/plain' });
    const res = await w.send({ method: 'GET', path: r('doc'), ...as(w) });
    expect(res.header('content-type')).toBe('text/plain');
    expect(res.text).toBe('plain');
  });

  it('serves user content so it cannot run on the API origin', async () => {
    const w = await world();
    await w.send({
      method: 'PUT',
      path: r('page.html'),
      ...as(w),
      body: '<script>alert(1)</script>',
      contentType: 'text/html',
    });
    const res = await w.send({ method: 'GET', path: r('page.html'), ...as(w) });
    expect(res.header('content-security-policy')).toBe('sandbox');
    expect(res.header('x-content-type-options')).toBe('nosniff');
  });
});

describe('Resources: POST', () => {
  it('creates under a server-chosen id: 201, absolute Location, ETag', async () => {
    const w = await world();
    const res = await w.send({ method: 'POST', path: `space/${S}/${C}/`, ...as(w), json: { message: 'hi' } });
    expect(res.status).toBe(201);
    expect(res.header('location')).toBe(`${ORIGIN}/space/${S}/${C}/gen-1`);
    expect(res.header('etag')).toBeDefined();
    // the body names the new Resource and mirrors the stored type (the reference server's does, and its client reads it)
    expect(res.json).toEqual({
      id: 'gen-1',
      url: `/space/${S}/${C}/gen-1`,
      'content-type': 'application/json',
    });
    expect((await w.send({ method: 'GET', path: r('gen-1'), ...as(w) })).json).toEqual({ message: 'hi' });
  });

  it('answers a POST of another type with that type in the body', async () => {
    const w = await world();
    const res = await w.send({
      method: 'POST',
      path: `space/${S}/${C}/`,
      ...as(w),
      body: 'plain',
      contentType: 'text/plain',
    });
    expect(res.status).toBe(201);
    expect(res.json['content-type']).toBe('text/plain');
  });

  it('does not accept POST at a Resource URL', async () => {
    const w = await world();
    const res = await w.send({ method: 'POST', path: r('x'), ...as(w), json: {} });
    expect(res.status).toBe(405);
    expect(res.header('allow')).toBe('GET, HEAD, PUT, DELETE');
  });
});

describe('Resources: absent and unauthorized look alike', () => {
  it('404s a Resource that is not there, in a Collection that is not there, in a Space that is not there', async () => {
    const w = await world();
    for (const path of [r('nope'), `space/${S}/none/x`, 'space/none/c/x']) {
      const res = await w.send({ method: 'GET', path, ...as(w) });
      expect(res.status).toBe(404);
      expect(res.type).toBe('not-found');
    }
  });

  it('shows a stranger and an anonymous caller exactly what it shows for an absent Resource', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'secret', { s: 1 });
    const bodies = new Set<string>();
    for (const req of [{ as: bob }, {}, { as: alice, root: w.spaceUrl(S) }]) {
      const res = await w.send({ method: 'GET', path: r(req.as === alice ? 'absent' : 'secret'), ...req });
      expect(res.status).toBe(404);
      bodies.add(res.text);
    }

    expect(bodies.size).toBe(1);
  });

  it('refuses a stranger a write, a delete and a metadata read — all 404, nothing changed', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { v: 1 });
    expect((await w.send({ method: 'PUT', path: r('doc'), as: bob, json: { v: 2 } })).status).toBe(404);
    expect((await w.send({ method: 'DELETE', path: r('doc'), as: bob })).status).toBe(404);
    expect((await w.send({ method: 'GET', path: `${r('doc')}/meta`, as: bob })).status).toBe(404);
    expect((await w.send({ method: 'GET', path: r('doc'), ...as(w) })).json).toEqual({ v: 1 });
  });

  it('answers a write to a missing Collection 404, even for the controller', async () => {
    const w = await world();
    expect((await w.send({ method: 'PUT', path: `space/${S}/none/x`, ...as(w), json: {} })).status).toBe(404);
  });
});

describe('Resources: delete', () => {
  it('deletes, and is idempotent for an authorized caller', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { v: 1 });
    expect((await w.send({ method: 'DELETE', path: r('doc'), ...as(w) })).status).toBe(204);
    expect((await w.send({ method: 'GET', path: r('doc'), ...as(w) })).status).toBe(404);
    expect((await w.send({ method: 'DELETE', path: r('doc'), ...as(w) })).status).toBe(204);
  });
});

describe('Resources: conditional requests', () => {
  it('answers 304 to a matching If-None-Match on GET and HEAD', async () => {
    const w = await world();
    const put = await w.putResource(alice, S, C, 'doc', { v: 1 });
    const etag = put.header('etag') as string;
    for (const method of ['GET', 'HEAD']) {
      const res = await w.send({ method, path: r('doc'), ...as(w), headers: { 'if-none-match': etag } });
      expect(res.status).toBe(304);
      expect(res.header('etag')).toBe(etag);
    }

    expect(
      (await w.send({ method: 'GET', path: r('doc'), ...as(w), headers: { 'if-none-match': '"other.1"' } }))
        .status,
    ).toBe(200);
  });

  it('writes only if unchanged: If-Match', async () => {
    const w = await world();
    const etag = (await w.putResource(alice, S, C, 'doc', { v: 1 })).header('etag') as string;
    const ok = await w.send({
      method: 'PUT',
      path: r('doc'),
      ...as(w),
      headers: { 'if-match': etag },
      json: { v: 2 },
    });
    expect(ok.status).toBe(204);
    const stale = await w.send({
      method: 'PUT',
      path: r('doc'),
      ...as(w),
      headers: { 'if-match': etag },
      json: { v: 3 },
    });
    expect(stale.status).toBe(412);
    expect(stale.type).toBe('precondition-failed');
    expect((await w.send({ method: 'GET', path: r('doc'), ...as(w) })).json).toEqual({ v: 2 });
  });

  it('creates only if absent: If-None-Match: *', async () => {
    const w = await world();
    const first = await w.send({
      method: 'PUT',
      path: r('doc'),
      ...as(w),
      headers: { 'if-none-match': '*' },
      json: { v: 1 },
    });
    expect(first.status).toBe(204);
    const second = await w.send({
      method: 'PUT',
      path: r('doc'),
      ...as(w),
      headers: { 'if-none-match': '*' },
      json: { v: 2 },
    });
    expect(second.status).toBe(412);
  });

  it('does not let a stranger observe a 412: authorization comes first', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { v: 1 });
    const res = await w.send({
      method: 'PUT',
      path: r('doc'),
      as: bob,
      headers: { 'if-none-match': '*' },
      json: {},
    });
    expect(res.status).toBe(404);
  });

  it('fails an If-Match on a Resource that does not exist, and a conditional delete', async () => {
    const w = await world();
    expect(
      (
        await w.send({
          method: 'PUT',
          path: r('ghost'),
          ...as(w),
          headers: { 'if-match': '"a.1"' },
          json: {},
        })
      ).status,
    ).toBe(412);
    const etag = (await w.putResource(alice, S, C, 'doc', {})).header('etag') as string;
    expect(
      (await w.send({ method: 'DELETE', path: r('doc'), ...as(w), headers: { 'if-match': '"a.1"' } })).status,
    ).toBe(412);
    expect(
      (await w.send({ method: 'DELETE', path: r('doc'), ...as(w), headers: { 'if-match': etag } })).status,
    ).toBe(204);
  });

  it('never reuses a validator after a delete and re-create', async () => {
    const w = await world();
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      seen.add((await w.putResource(alice, S, C, 'doc', { i })).header('etag') as string);
      await w.send({ method: 'DELETE', path: r('doc'), ...as(w) });
    }

    expect(seen.size).toBe(3);
  });
});

describe('Resources: attribution', () => {
  it('records createdBy once and the Writer-Id and Key-Epoch of the last content write', async () => {
    const w = await world();
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: `${w.spaceUrl(S)}${C}/`,
      actions: ['GET', 'PUT'],
    });
    await w.send({
      method: 'PUT',
      path: r('doc'),
      as: app,
      via: grant,
      headers: { 'writer-id': 'z6fVXHKn', 'key-epoch': 'e1' },
      json: { v: 1 },
    });
    await w.send({
      method: 'PUT',
      path: r('doc'),
      ...as(w),
      headers: { 'writer-id': 'laptop' },
      json: { v: 2 },
    });
    const meta = (await w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w) })).json;
    expect(meta.createdBy).toBe(app.did); // the creator, not the last writer
    expect(meta.writerId).toBe('laptop');
    expect(meta.epoch).toBeUndefined(); // a content write without the header clears the stamp
    await w.send({ method: 'PUT', path: r('doc'), ...as(w), json: { v: 3 } });
    expect(
      (await w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w) })).json.writerId,
    ).toBeUndefined();
  });

  it('refuses an empty or malformed Writer-Id', async () => {
    const w = await world();
    for (const value of ['', 'has space', 'x'.repeat(129)]) {
      const res = await w.send({
        method: 'PUT',
        path: r('doc'),
        ...as(w),
        headers: { 'writer-id': value },
        json: {},
      });
      expect(res.status).toBe(400);
      expect(res.type).toBe('invalid-request-body');
    }
  });

  it('lists writerId and epoch on the items', async () => {
    const w = await world();
    await w.send({
      method: 'PUT',
      path: r('doc'),
      ...as(w),
      headers: { 'writer-id': 'w1', 'key-epoch': 'e2' },
      json: {},
    });
    const item = (await w.send({ method: 'GET', path: `space/${S}/${C}/`, ...as(w) })).json.items[0];
    expect(item).toEqual({
      id: 'doc',
      url: `/space/${S}/${C}/doc`,
      contentType: 'application/json',
      epoch: 'e2',
      writerId: 'w1',
    });
  });
});

describe('Resource Metadata: /meta', () => {
  it('reports server-managed members; PUT replaces custom without touching the content validator or updatedAt', async () => {
    const w = await world();
    const putEtag = (await w.putResource(alice, S, C, 'doc', { v: 1 })).header('etag') as string;
    const before = (await w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w) })).json;
    expect(before).toEqual({
      contentType: 'application/json',
      size: 7,
      createdAt: '2026-11-05T12:00:00.000Z',
      updatedAt: '2026-11-05T12:00:00.000Z',
      updatedAtCounter: expect.any(Number),
      originId: 'test-origin',
      createdBy: alice.did,
    });

    w.advance(60);
    const metaPut = await w.send({
      method: 'PUT',
      path: `${r('doc')}/meta`,
      ...as(w),
      json: { custom: { name: 'Hello', tags: { project: 'demo' } }, updatedAt: 'ignored', size: 999 },
    });
    expect(metaPut.status).toBe(204);
    const after = (await w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w) })).json;
    expect(after.custom).toEqual({ name: 'Hello', tags: { project: 'demo' } });
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.size).toBe(7);
    expect((await w.send({ method: 'GET', path: r('doc'), ...as(w) })).header('etag')).toBe(putEtag);

    // a metadata write has an ETag of its own
    const metaEtag = metaPut.header('etag');
    expect(metaEtag).toBeDefined();
    expect(metaEtag).not.toBe(putEtag);

    // `{}` clears the annotations; a content write keeps them
    await w.putResource(alice, S, C, 'doc', { v: 2 });
    expect((await w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w) })).json.custom).toEqual({
      name: 'Hello',
      tags: { project: 'demo' },
    });
    await w.send({ method: 'PUT', path: `${r('doc')}/meta`, ...as(w), json: {} });
    expect((await w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w) })).json.custom).toBeUndefined();
  });

  it('never creates: a missing Resource is 404, and an invalid custom is 400', async () => {
    const w = await world();
    expect(
      (await w.send({ method: 'PUT', path: `${r('ghost')}/meta`, ...as(w), json: { custom: { name: 'x' } } }))
        .status,
    ).toBe(404);
    await w.putResource(alice, S, C, 'doc', {});
    for (const custom of ['x', [], { name: 3 }, { tags: 'x' }]) {
      expect(
        (await w.send({ method: 'PUT', path: `${r('doc')}/meta`, ...as(w), json: { custom } })).type,
      ).toBe('invalid-request-body');
    }
  });

  it('is conditional on its own validator', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', {});
    const etag = (await w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w) })).header(
      'etag',
    ) as string;
    expect(
      (
        await w.send({
          method: 'GET',
          path: `${r('doc')}/meta`,
          ...as(w),
          headers: { 'if-none-match': etag },
        })
      ).status,
    ).toBe(304);
    expect(
      (
        await w.send({
          method: 'PUT',
          path: `${r('doc')}/meta`,
          ...as(w),
          headers: { 'if-match': '"x.1"' },
          json: {},
        })
      ).status,
    ).toBe(412);
  });
});

describe('Unique plaintext indexes', () => {
  async function unique(): Promise<World> {
    const w = await world();
    await w.createCollection(alice, S, 'posts', { plaintext: { indexes: [{ name: 'slug', unique: true }] } });

    return w;
  }

  const put = (w: World, id: string, json: unknown) =>
    w.send({ method: 'PUT', path: `space/${S}/posts/${id}`, ...as(w), json });

  it('refuses a second Resource that claims a held value: 409 id-conflict', async () => {
    const w = await unique();
    expect((await put(w, 'one', { slug: 'hello-world' })).status).toBe(204);
    const clash = await put(w, 'two', { slug: 'hello-world' });
    expect(clash.status).toBe(409);
    expect(clash.type).toBe('id-conflict');
    expect((await put(w, 'two', { slug: 'other' })).status).toBe(204);
  });

  it('lets a Resource re-assert its own value, and ignores Resources that lack the attribute', async () => {
    const w = await unique();
    expect((await put(w, 'one', { slug: 'a' })).status).toBe(204);
    expect((await put(w, 'one', { slug: 'a', extra: 1 })).status).toBe(204);
    expect((await put(w, 'x', { nothing: 1 })).status).toBe(204);
    expect((await put(w, 'y', { nothing: 2 })).status).toBe(204);
  });

  it('compares the JSON value, so 1 and "1" differ', async () => {
    const w = await unique();
    expect((await put(w, 'n', { slug: 1 })).status).toBe(204);
    expect((await put(w, 's', { slug: '1' })).status).toBe(204);
    expect((await put(w, 'n2', { slug: 1 })).status).toBe(409);
  });

  it('refuses to declare an attribute unique over Resources that already collide', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'late');
    for (const id of ['first', 'second']) {
      await w.putResource(alice, S, 'late', id, { slug: 'same' });
    }

    const res = await w.send({
      method: 'PUT',
      path: `space/${S}/late/meta`,
      ...as(w),
      json: { id: 'late', plaintext: { indexes: [{ name: 'slug', unique: true }] } },
    });
    expect(res.status).toBe(409);
    expect(res.type).toBe('id-conflict');
    const read = (await w.send({ method: 'GET', path: `space/${S}/late/meta`, ...as(w) })).json;
    expect(read.plaintext).toBeUndefined();
  });
});

describe('Resource Metadata: its ETag follows the content too', () => {
  it('answers 200, not 304, once a content write has changed the size and the type', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { a: 1 });
    const first = await w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w) });
    expect(first.json.size).toBe(7);
    await w.send({
      method: 'PUT',
      path: r('doc'),
      ...as(w),
      body: new Uint8Array(32),
      contentType: 'application/octet-stream',
    });
    const conditional = (etag: string) =>
      w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w), headers: { 'if-none-match': etag } });
    const again = await conditional(first.header('etag') as string);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ size: 32, contentType: 'application/octet-stream' });
    expect(again.header('etag')).not.toBe(first.header('etag'));
    expect((await conditional(again.header('etag') as string)).status).toBe(304); // unchanged since
  });

  it('refuses with 412 an annotation write based on a Metadata object the content has since changed', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { a: 1 });
    const seen = (await w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w) })).header(
      'etag',
    ) as string;
    await w.putResource(alice, S, C, 'doc', { a: 2 });
    const stale = await w.send({
      method: 'PUT',
      path: `${r('doc')}/meta`,
      ...as(w),
      headers: { 'if-match': seen },
      json: { custom: { name: 'late' } },
    });
    expect(stale.status).toBe(412);
    const current = (await w.send({ method: 'GET', path: `${r('doc')}/meta`, ...as(w) })).header(
      'etag',
    ) as string;
    expect(
      (
        await w.send({
          method: 'PUT',
          path: `${r('doc')}/meta`,
          ...as(w),
          headers: { 'if-match': current },
          json: { custom: { name: 'ok' } },
        })
      ).status,
    ).toBe(204);
  });
});

describe('hardening found by review', () => {
  it('does not overwrite a Resource when a generated id repeats', async () => {
    const w = new World({ generateId: () => 'same-id' });
    await w.createSpace(alice, S);
    await w.createCollection(alice, S, C).catch(() => undefined);
    const first = await w.send({ method: 'POST', path: `space/${S}/${C}/`, ...as(w), json: { v: 1 } });
    expect(first.status).toBe(201);
    const second = await w.send({ method: 'POST', path: `space/${S}/${C}/`, ...as(w), json: { v: 2 } });
    expect([second.status, second.type]).toEqual([409, 'id-conflict']);
    expect((await w.send({ method: 'GET', path: r('same-id'), ...as(w) })).json).toEqual({ v: 1 });
  });

  it('repeats Cache-Control on a 304, as it is on the 200', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { v: 1 });
    const ok = await w.send({ method: 'GET', path: r('doc'), ...as(w) });
    const again = await w.send({
      method: 'GET',
      path: r('doc'),
      ...as(w),
      headers: { 'if-none-match': ok.header('etag') as string },
    });
    expect(again.status).toBe(304);
    expect(again.header('cache-control')).toBe(ok.header('cache-control'));
    expect(again.header('cache-control')).toBe('private, no-cache');
  });
});
