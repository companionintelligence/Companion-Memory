import { createPwsHandler } from './handler';
import { MemoryPwsStore } from './store';
import { ORIGIN_ID, compareStamps } from './stamp';
import type { Stamp } from './stamp';
import { ORIGIN, World, alice } from './__tests__/testKit';

const S = 'space-1';
const C = 'messages';

async function world(): Promise<World> {
  const w = new World();
  await w.createSpace(alice, S);
  await w.createCollection(alice, S, C);
  return w;
}

/** A Metadata object as read back: its own stamp, and for a Resource the stamp of its annotations. */
type WithMeta = Stamp & { meta: Stamp };

const as = (w: World) => ({ as: alice, root: w.spaceUrl(S) });
const stampOf = (doc: Stamp): Stamp => ({
  updatedAt: doc.updatedAt,
  updatedAtCounter: doc.updatedAtCounter,
  originId: doc.originId,
});
const resourceMeta = async (w: World, id = 'doc') =>
  (await w.send({ method: 'GET', path: `space/${S}/${C}/${id}/meta`, ...as(w) })).json;

describe('write stamps on Metadata objects', () => {
  it('puts the three members on a Space, a Collection and a Resource, at millisecond precision', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { v: 1 });
    const space = (await w.send({ method: 'GET', path: `space/${S}/meta`, ...as(w) })).json;
    const collection = (await w.send({ method: 'GET', path: `space/${S}/${C}/meta`, ...as(w) })).json;
    const resource = await resourceMeta(w);
    for (const doc of [space, collection, resource]) {
      expect(doc.updatedAt).toBe('2026-11-05T12:00:00.000Z');
      expect(Number.isInteger(doc.updatedAtCounter) && doc.updatedAtCounter >= 0).toBe(true);
      expect(doc.originId).toBe('test-origin');
    }
  });

  it('advertises the store that mints them in the service description', async () => {
    const w = await world();
    const entry = (await w.send({ method: 'GET', path: 'service' })).json.specs['https://w3id.org/pws'][0];
    expect(entry.originId).toBe('test-origin');
  });

  it('gives a handler that was not told an origin a random, legal one, and says so', async () => {
    const handler = createPwsHandler({ baseUrl: `${ORIGIN}/`, store: new MemoryPwsStore() });
    const res = await handler.handle({
      method: 'GET',
      url: `${ORIGIN}/service`,
      headers: { host: 'example.com' },
    });
    const entry = JSON.parse(new TextDecoder().decode(res.body)).specs['https://w3id.org/pws'][0];
    expect(entry.originId).toMatch(ORIGIN_ID);
  });

  it('orders two writes of one Resource inside one millisecond', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { v: 1 });
    const first = stampOf(await resourceMeta(w));
    await w.putResource(alice, S, C, 'doc', { v: 2 });
    const second = stampOf(await resourceMeta(w));
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(compareStamps(second, first)).toBeGreaterThan(0);
  });

  it('does not let the stamp go backwards when the server clock does', async () => {
    const w = await world();
    w.advance(60);
    await w.putResource(alice, S, C, 'doc', { v: 1 });
    const first = stampOf(await resourceMeta(w));
    w.advance(-30);
    await w.putResource(alice, S, C, 'doc', { v: 2 });
    const second = stampOf(await resourceMeta(w));
    expect(compareStamps(second, first)).toBeGreaterThan(0);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it('moves the Space stamp on an update and the Collection stamp on an update', async () => {
    const w = await world();
    const spaceBefore = stampOf((await w.send({ method: 'GET', path: `space/${S}/meta`, ...as(w) })).json);
    const collectionBefore = stampOf(
      (await w.send({ method: 'GET', path: `space/${S}/${C}/meta`, ...as(w) })).json,
    );
    w.advance(5);
    expect(
      (
        await w.send({
          method: 'PUT',
          path: `space/${S}/meta`,
          ...as(w),
          json: { controller: alice.did, name: 'n' },
        })
      ).status,
    ).toBe(204);
    expect(
      (await w.send({ method: 'PUT', path: `space/${S}/${C}/meta`, ...as(w), json: { name: 'n' } })).status,
    ).toBe(204);
    const spaceAfter = stampOf((await w.send({ method: 'GET', path: `space/${S}/meta`, ...as(w) })).json);
    const collectionAfter = stampOf(
      (await w.send({ method: 'GET', path: `space/${S}/${C}/meta`, ...as(w) })).json,
    );
    expect(spaceAfter.updatedAt).toBe('2026-11-05T12:00:05.000Z');
    expect(compareStamps(spaceAfter, spaceBefore)).toBeGreaterThan(0);
    expect(collectionAfter.updatedAt).toBe('2026-11-05T12:00:05.000Z');
    expect(compareStamps(collectionAfter, collectionBefore)).toBeGreaterThan(0);
  });

  it('ignores a stamp the client writes: the server alone mints them', async () => {
    const w = await world();
    w.advance(5);
    const forged = { updatedAt: '1999-01-01T00:00:00.000Z', updatedAtCounter: 999, originId: 'forged' };
    await w.send({
      method: 'PUT',
      path: `space/${S}/meta`,
      ...as(w),
      json: { controller: alice.did, ...forged },
    });
    await w.send({ method: 'PUT', path: `space/${S}/${C}/meta`, ...as(w), json: { name: 'n', ...forged } });
    await w.send({ method: 'PUT', path: `space/${S}/${C}/doc`, ...as(w), json: { v: 1 } });
    await w.send({
      method: 'PUT',
      path: `space/${S}/${C}/doc/meta`,
      ...as(w),
      json: { custom: { name: 'x' }, ...forged, meta: forged },
    });
    const docs = [
      (await w.send({ method: 'GET', path: `space/${S}/meta`, ...as(w) })).json,
      (await w.send({ method: 'GET', path: `space/${S}/${C}/meta`, ...as(w) })).json,
      await resourceMeta(w),
    ];
    for (const doc of docs) {
      expect(doc.originId).toBe('test-origin');
      expect(doc.updatedAt).toBe('2026-11-05T12:00:05.000Z');
    }
    expect(docs[2].meta.originId).toBe('test-origin');
  });
});

describe('write stamps of Resource content and Resource metadata', () => {
  it('keeps them apart: a metadata write gets a stamp of its own and leaves the content stamp', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { v: 1 });
    const before = await resourceMeta(w);
    expect(before.meta).toBeUndefined();

    w.advance(60);
    await w.send({
      method: 'PUT',
      path: `space/${S}/${C}/doc/meta`,
      ...as(w),
      json: { custom: { name: 'n' } },
    });
    const after = await resourceMeta(w);
    expect(stampOf(after)).toEqual(stampOf(before));
    expect(after.meta.updatedAt).toBe('2026-11-05T12:01:00.000Z');
    expect(after.meta.originId).toBe('test-origin');
    expect(compareStamps(stampOf(after.meta), stampOf(before))).toBeGreaterThan(0);
    expect(typeof after.meta.generation).toBe('string');
  });

  it('lets a later content write move the content stamp and keep the metadata stamp', async () => {
    const w = await world();
    await w.putResource(alice, S, C, 'doc', { v: 1 });
    w.advance(60);
    await w.send({
      method: 'PUT',
      path: `space/${S}/${C}/doc/meta`,
      ...as(w),
      json: { custom: { name: 'n' } },
    });
    const written = await resourceMeta(w);

    w.advance(60);
    await w.putResource(alice, S, C, 'doc', { v: 2 });
    const rewritten = await resourceMeta(w);
    expect(rewritten.meta).toEqual(written.meta);
    expect(rewritten.updatedAt).toBe('2026-11-05T12:02:00.000Z');
    expect(compareStamps(stampOf(rewritten), stampOf(written))).toBeGreaterThan(0);
  });

  it('stamps the 201 of a POST with the stored content', async () => {
    const w = await world();
    const created = await w.send({ method: 'POST', path: `space/${S}/${C}/`, ...as(w), json: { v: 1 } });
    const id = created.json.id as string;
    expect((await resourceMeta(w, id)).originId).toBe('test-origin');
  });
});

describe('write stamps survive a second handler or a restart over the same store', () => {
  const doc = (w: World) => w.send({ method: 'GET', path: `space/${S}/${C}/doc/meta`, ...as(w) });

  it('sorts a later write of a record after an earlier one, even when a new clock minted it', async () => {
    const store = new MemoryPwsStore();
    const a = new World({ store, originId: 'node-a' });
    await a.createSpace(alice, S);
    await a.createCollection(alice, S, C);
    await a.putResource(alice, S, C, 'doc', { v: 1 });
    await a.putResource(alice, S, C, 'doc', { v: 2 });
    const earlier = stampOf((await doc(a)).json);

    // a second handler over the same store, at the same instant: its clock has never seen node-a's
    const b = new World({ store, originId: 'node-b' });
    await b.putResource(alice, S, C, 'doc', { v: 3 });
    const later = stampOf((await doc(b)).json);
    expect(compareStamps(later, earlier)).toBeGreaterThan(0);
  });

  it('does the same after a restart whose wall clock is behind the stored stamp', async () => {
    const store = new MemoryPwsStore();
    const a = new World({ store, originId: 'node-a' });
    await a.createSpace(alice, S);
    await a.createCollection(alice, S, C);
    a.advance(600);
    await a.putResource(alice, S, C, 'doc', { v: 1 });
    const earlier = stampOf((await doc(a)).json);

    const restarted = new World({ store, originId: 'node-a' }); // a fresh clock at T0, ten minutes behind
    await restarted.putResource(alice, S, C, 'doc', { v: 2 });
    const later = stampOf((await doc(restarted)).json);
    expect(compareStamps(later, earlier)).toBeGreaterThan(0);
  });

  // One write per fresh handler: an earlier write in the same handler would have moved its clock past the
  // stamp being replaced, and hidden a missing `observe`.
  it.each([
    ['Space', `space/${S}/meta`, { controller: alice.did, name: 'n' }, (doc: WithMeta): Stamp => doc],
    ['Collection', `space/${S}/${C}/meta`, { name: 'n' }, (doc: WithMeta): Stamp => doc],
    [
      'Resource metadata',
      `space/${S}/${C}/doc/meta`,
      { custom: { name: 'n' } },
      (doc: WithMeta): Stamp => doc.meta,
    ],
  ])(
    'applies to the %s too: a fresh clock cannot sort a rewrite before the version it replaces',
    async (_kind, path, json, pick) => {
      const store = new MemoryPwsStore();
      const a = new World({ store, originId: 'node-a' });
      await a.createSpace(alice, S);
      await a.createCollection(alice, S, C);
      await a.putResource(alice, S, C, 'doc', { v: 1 });
      a.advance(600);
      const write = (w: World) => w.send({ method: 'PUT', path, ...as(w), json });
      const stamp = async (w: World) => stampOf(pick((await w.send({ method: 'GET', path, ...as(w) })).json));
      expect((await write(a)).status).toBe(204);
      const before = await stamp(a);
      const b = new World({ store, originId: 'node-b' }); // a clock that has seen nothing, ten minutes behind
      expect((await write(b)).status).toBe(204);
      expect(compareStamps(await stamp(b), before)).toBeGreaterThan(0);
    },
  );
});
